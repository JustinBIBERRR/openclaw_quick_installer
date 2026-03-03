//go:build !windows

package steps

import "os/exec"

func setHideWindow(_ *exec.Cmd)       {}
func setDetachedProcess(_ *exec.Cmd)  {}
func setBackgroundProcess(_ *exec.Cmd) {}
