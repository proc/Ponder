//go:build windows

package uci

import (
	"os/exec"
	"syscall"
)

// hideWindow stops a console window from flashing up for each engine.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
}
