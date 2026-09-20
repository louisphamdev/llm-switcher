# Run this repository on Linux, macOS and Windows

The gateway is plain Node.js with no dependencies. Nothing in the source holds an
absolute Windows path. Every command that differs between platforms has a branch for
each one. This guide states what to install, what changes per platform, and which two
features are not available everywhere.

## What you need

| Item | Why |
| --- | --- |
| Node.js 18.17 or later | The gateway, the launcher and the interceptor |
| `bash` and `openssl` | Only for blindfold mode, to build the certificates |
| Nothing else | `npm install` is not necessary. The package has no dependencies. |

Linux and macOS have `bash` and `openssl` already. On Windows both arrive with Git for
Windows, inside Git Bash.

## Install

The steps are the same on all three platforms.

```bash
git clone https://github.com/louisphamdev/llm-switcher.git
cd llm-switcher
cp config.example.json config.json
```

Edit `config.json`, then start the gateway:

```bash
node switch.mjs on
```

## Put `switch` on PATH

The repository holds two launchers. Both run the same `switch.mjs`.

| Platform | File | How to reach it |
| --- | --- | --- |
| Linux, macOS | `switch` | `export PATH="/path/to/llm-switcher:$PATH"` in `~/.bashrc` or `~/.zshrc` |
| Windows | `switch.cmd` | Add the repository directory to the user PATH |

After that, `switch status`, `switch codex <profile>` and `switch off` behave the same
everywhere. If you prefer not to change PATH, run `node switch.mjs <command>` instead.

If `switch` reports "permission denied" on Linux or macOS, the executable bit was lost
in transfer. Restore it:

```bash
chmod +x switch
```

## What the switcher writes for each platform

`switch` writes both forms every time, so the same working copy serves a shell and a
command prompt:

| File | Read by |
| --- | --- |
| `env.sh`, `env-codex.sh` | The POSIX shims and any shell |
| `env.cmd`, `env-codex.cmd` | The Windows shims, Command Prompt and PowerShell |

The CLI shims follow the same rule. `switch shim install` writes
`~/.llm-switcher/bin/claude` and `~/.llm-switcher/bin/codex` on Linux and macOS, with
the executable bit set. On Windows it writes `claude.cmd` and `codex.cmd` in the same
directory. Put that directory before the real CLI in PATH:

```bash
export PATH="$HOME/.llm-switcher/bin:$PATH"     # Linux, macOS
```

```
%USERPROFILE%\.llm-switcher\bin                 # Windows: add before the Codex directory
```

## Commands that differ inside the code

You do not call these yourself. They are listed so that a reader knows the platform
work is already done.

| Task | Linux, macOS | Windows |
| --- | --- | --- |
| Find the process on a port | `lsof` | `netstat -ano` |
| Stop a process | `process.kill` | `taskkill /F /PID` |
| Open the dashboard | `xdg-open`, `open` | `cmd /c start` |

## Two features are not available everywhere

**`switch doctor` cannot inspect running CLI sessions on Windows.** That check reads the
environment of a live process with `pgrep` and `ps`, which exist only on Linux and
macOS. On Windows the rest of `switch doctor` still runs, and this one section reports
that it is not supported. A Windows user who wants the same answer must close the CLI
and start it again from a shell where the shim is on PATH.

**`make-certs.sh` cannot protect the key directory on Windows.** The script calls
`chmod 700` on `blindfold/certs/`, and that call does nothing under Git Bash for
Windows. On that platform the private keys are protected only by the permissions of the
account that owns the directory. Keep the repository in a user-owned location.

Four tests in `tests/shim.test.mjs` run the generated POSIX shim as a real program, so
they skip on Windows. The suite reports them as skipped, not as failures.

## Blindfold mode on each platform

Blindfold mode works on all three platforms, because it needs no administrator rights,
no `hosts` file change and no certificate in a system trust store. See
[`codex-blindfold.md`](codex-blindfold.md) for what it does.

Build the certificates once. On Windows, run this line in Git Bash, not in PowerShell:

```bash
bash blindfold/make-certs.sh chatgpt.com
```

The subject of the certificate must match the host your Codex account calls:

| Codex sign-in | Host | Profile keys |
| --- | --- | --- |
| ChatGPT account | `chatgpt.com` | The defaults. Add nothing. |
| API key | `api.openai.com` | `"blindfoldHost": "api.openai.com"`, `"blindfoldPrefix": "/v1"` |

`switch` compares the host in the profile against the subject alternative names of the
leaf certificate. If they differ it refuses the activation, names the host, and prints
the command that rebuilds the certificate. No file is written on that path.

## Check that the platform work succeeded

Run the test suite:

```bash
npm test
```

On Linux and macOS every test runs. On Windows four shim tests skip. A failure on any
platform is a real defect; report it with the platform name and the Node version.
