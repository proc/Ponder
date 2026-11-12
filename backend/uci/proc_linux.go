//go:build linux

package uci

import (
	"os/exec"
	"syscall"
)

// hideWindow (here: process setup) makes the engine die with the backend,
// even if the backend is killed without a chance to close it.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
}
