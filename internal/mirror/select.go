package mirror

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"time"

	"openclaw-manager/internal/proxy"
)

// Mirror 代表一个 Node.js 下载镜像
type Mirror struct {
	Name    string
	BaseURL string
}

// npmRegistryCandidate 代表一个 npm 包注册表候选
type npmRegistryCandidate struct {
	Name string
	URL  string
}

// npmPrimaryRegistry 国内优先镜像：实际下载速度远优于官方源
var npmPrimaryRegistry = npmRegistryCandidate{
	Name: "npmmirror（国内加速）",
	URL:  "https://registry.npmmirror.com",
}

// npmFallbackRegistry 官方源备用
var npmFallbackRegistry = npmRegistryCandidate{
	Name: "npmjs.org（官方）",
	URL:  "https://registry.npmjs.org",
}

// SelectNPMRegistry 优先使用 npmmirror（国内下载速度快），
// 若 npmmirror 不可达则回退到官方源。
// 注意：此处以"可达性"而非"ping 延迟"决策，因为官方 CDN ping 可能更低，
// 但大陆实际吞吐量远不如 npmmirror。
func SelectNPMRegistry(ctx context.Context) (name, url string) {
	client := proxy.NewHTTPClient(5 * time.Second)

	check := func(c npmRegistryCandidate) bool {
		req, err := http.NewRequestWithContext(ctx, http.MethodHead,
			c.URL+"/axios/latest", nil)
		if err != nil {
			return false
		}
		resp, err := client.Do(req)
		if err != nil {
			return false
		}
		resp.Body.Close()
		return resp.StatusCode >= 200 && resp.StatusCode < 400
	}

	// 先检查优先镜像
	if check(npmPrimaryRegistry) {
		return npmPrimaryRegistry.Name, npmPrimaryRegistry.URL
	}
	// 降级到官方源
	if check(npmFallbackRegistry) {
		return npmFallbackRegistry.Name, npmFallbackRegistry.URL
	}
	return "", ""
}

var candidates = []Mirror{
	{Name: "npmmirror（国内）", BaseURL: "https://npmmirror.com/mirrors/node/"},
	{Name: "腾讯云镜像", BaseURL: "https://mirrors.cloud.tencent.com/nodejs-release/"},
	{Name: "nodejs.org（官方）", BaseURL: "https://nodejs.org/dist/"},
}

// NodeZipURL 返回指定版本的 zip 下载地址
func (m Mirror) NodeZipURL(version string) string {
	return fmt.Sprintf("%sv%s/node-v%s-win-x64.zip", m.BaseURL, version, version)
}

// SHASUMS256URL 返回 SHA256 校验文件地址
func (m Mirror) SHASUMS256URL(version string) string {
	return fmt.Sprintf("%sv%s/SHASUMS256.txt", m.BaseURL, version)
}

type result struct {
	mirror  Mirror
	latency time.Duration
}

// SelectFastest 并发探测所有镜像，返回响应最快的可用镜像。
// 若全部失败，回退返回 nodejs.org 官方镜像。
func SelectFastest(ctx context.Context) (Mirror, time.Duration) {
	client := proxy.NewHTTPClient(5 * time.Second)

	resultCh := make(chan result, len(candidates))
	var wg sync.WaitGroup

	for _, m := range candidates {
		wg.Add(1)
		go func(m Mirror) {
			defer wg.Done()
			start := time.Now()
			req, err := http.NewRequestWithContext(ctx, http.MethodHead,
				fmt.Sprintf("%sindex.json", m.BaseURL), nil)
			if err != nil {
				return
			}
			resp, err := client.Do(req)
			if err != nil {
				return
			}
			resp.Body.Close()
			if resp.StatusCode < 200 || resp.StatusCode >= 400 {
				return
			}
			resultCh <- result{mirror: m, latency: time.Since(start)}
		}(m)
	}

	go func() {
		wg.Wait()
		close(resultCh)
	}()

	// 取第一个成功响应
	for r := range resultCh {
		return r.mirror, r.latency
	}

	// 全部失败，返回官方镜像
	return candidates[len(candidates)-1], 0
}
