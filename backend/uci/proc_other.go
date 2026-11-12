//go:build !windows && !linux

package uci

import "os/exec"

// hideWindow has nothing to do outside Windows.
func hideWindow(cmd *exec.Cmd) {}
