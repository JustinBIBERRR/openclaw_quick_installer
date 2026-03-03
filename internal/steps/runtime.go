package steps

import (
	"archive/zip"
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"openclaw-manager/internal/mirror"
	"openclaw-manager/internal/proxy"
	"openclaw-manager/internal/state"
	"openclaw-manager/internal/ui"
)

// RunRuntimeDownload 下载并解压 Node.js 到安装目录
func RunRuntimeDownload(m *state.Manifest) error {
	if m.IsDone(state.StepRuntimeDownloaded) {
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	sel, latency := mirror.SelectFastest(ctx)
	cancel()

	if latency > 0 {
		ui.PrintInfo(fmt.Sprintf("使用镜像: %s (延迟 %dms)", sel.Name, latency.Milliseconds()))
	} else {
		ui.PrintWarn(fmt.Sprintf("使用镜像: %s (连接较慢)", sel.Name))
	}

	version := m.NodeVersion
	zipURL := sel.NodeZipURL(version)
	sha256URL := sel.SHASUMS256URL(version)

	// 获取期望的 SHA256
	ui.PrintInfo("获取校验文件...")
	expectedHash, err := fetchExpectedHash(sha256URL, fmt.Sprintf("node-v%s-win-x64.zip", version))
	if err != nil {
		ui.PrintWarn(fmt.Sprintf("无法获取校验文件（%v），跳过 SHA256 验证", err))
		expectedHash = "" // 允许跳过验证
	}

	// 准备目标路径
	runtimeDir := filepath.Join(m.InstallDir, "runtime")
	if err := os.MkdirAll(runtimeDir, 0755); err != nil {
		return fmt.Errorf("创建目录失败: %w", err)
	}
	zipPath := filepath.Join(runtimeDir, fmt.Sprintf("node-v%s-win-x64.zip", version))

	// 下载
	ui.PrintInfo(fmt.Sprintf("正在下载 Node.js v%s...", version))
	if err := downloadWithProgress(zipURL, zipPath); err != nil {
		os.Remove(zipPath)
		return fmt.Errorf("下载失败: %w", err)
	}

	// SHA256 验证
	if expectedHash != "" {
		ui.PrintInfo("正在验证文件完整性...")
		actualHash, err := hashFile(zipPath)
		if err != nil {
			os.Remove(zipPath)
			return fmt.Errorf("读取文件失败: %w", err)
		}
		if !strings.EqualFold(actualHash, expectedHash) {
			os.Remove(zipPath)
			return fmt.Errorf("文件校验失败（hash 不匹配），请重试")
		}
		ui.PrintOK("文件完整性验证通过")
	}

	// 解压
	nodeDir := m.NodeDir()
	if err := os.RemoveAll(nodeDir); err != nil {
		return fmt.Errorf("清理旧版本失败: %w", err)
	}

	var spinner error
	err = ui.WithSpinner("正在解压 Node.js...", func() error {
		return extractNodeZip(zipPath, nodeDir)
	})
	if err != nil || spinner != nil {
		os.RemoveAll(nodeDir)
		return fmt.Errorf("解压失败: %w", err)
	}
	ui.PrintOK(fmt.Sprintf("Node.js v%s 部署完成", version))

	// 清理 zip 文件
	os.Remove(zipPath)

	meta := map[string]string{"node_version": version}
	if expectedHash != "" {
		meta["hash"] = "sha256:" + expectedHash
	}
	return m.MarkDone(state.StepRuntimeDownloaded, meta)
}

// downloadWithProgress 流式下载文件，显示真实 HTTP 进度
func downloadWithProgress(url, destPath string) error {
	client := proxy.NewHTTPClient(0) // 下载不设全局超时
	client.Timeout = 0

	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return err
	}

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("连接失败: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("服务器返回 HTTP %d", resp.StatusCode)
	}

	f, err := os.Create(destPath)
	if err != nil {
		return err
	}
	defer f.Close()

	total := resp.ContentLength
	var downloaded int64
	buf := make([]byte, 32*1024)

	var lastUpdate time.Time
	var lastBytes int64

	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, writeErr := f.Write(buf[:n]); writeErr != nil {
				return writeErr
			}
			downloaded += int64(n)

			now := time.Now()
			if now.Sub(lastUpdate) >= 200*time.Millisecond {
				elapsed := now.Sub(lastUpdate).Seconds()
				speed := float64(downloaded-lastBytes) / elapsed
				ui.PrintDownloadProgress(downloaded, total, speed)
				lastUpdate = now
				lastBytes = downloaded
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return readErr
		}
	}

	ui.PrintDownloadDone(downloaded)
	return nil
}

// fetchExpectedHash 从 SHASUMS256.txt 中解析指定文件名的 hash
func fetchExpectedHash(url, filename string) (string, error) {
	client := proxy.NewHTTPClient(15 * time.Second)
	resp, err := client.Get(url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		line := scanner.Text()
		// 格式: "hash  filename"
		parts := strings.Fields(line)
		if len(parts) == 2 && strings.EqualFold(parts[1], filename) {
			return parts[0], nil
		}
	}
	return "", fmt.Errorf("在 SHASUMS256.txt 中未找到 %s", filename)
}

func hashFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// extractNodeZip 解压 Node.js zip，剥离顶层目录后放入 destDir
func extractNodeZip(zipPath, destDir string) error {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer r.Close()

	if err := os.MkdirAll(destDir, 0755); err != nil {
		return err
	}

	// 找到顶层目录名（如 node-v20.18.0-win-x64）
	topDir := ""
	for _, f := range r.File {
		parts := strings.SplitN(filepath.ToSlash(f.Name), "/", 2)
		if parts[0] != "" {
			topDir = parts[0] + "/"
			break
		}
	}

	for _, f := range r.File {
		name := filepath.ToSlash(f.Name)
		// 剥离顶层目录
		rel := strings.TrimPrefix(name, topDir)
		if rel == "" {
			continue
		}

		// 跳过 Node.js 自带的校验文件，运行时无需
		baseName := strings.ToUpper(filepath.Base(rel))
		if baseName == "SHASUMS256.TXT" || baseName == "SHASUMS256.TXT.ASC" || baseName == "SHASUMS256.TXT.SIG" {
			continue
		}

		destPath := filepath.Join(destDir, filepath.FromSlash(rel))

		if f.FileInfo().IsDir() {
			os.MkdirAll(destPath, 0755)
			continue
		}

		if err := os.MkdirAll(filepath.Dir(destPath), 0755); err != nil {
			return err
		}

		out, err := os.OpenFile(destPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, f.Mode())
		if err != nil {
			return err
		}

		rc, err := f.Open()
		if err != nil {
			out.Close()
			return err
		}

		_, copyErr := io.Copy(out, rc)
		rc.Close()
		out.Close()

		if copyErr != nil {
			return copyErr
		}
	}

	return nil
}
