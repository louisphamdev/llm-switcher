# Hide the gateway from the Codex CLI

## Diagrams

Open these next to the text. Each one is a standalone HTML page.

| Diagram | Shows |
| --- | --- |
| [Request routing](diagrams/blindfold-request-routing.html) | One Codex request, from CONNECT to the provider |
| [Model name resolution](diagrams/codex-model-name-resolution.html) | Which name the CLI sees, and where it resolves |
| [Lifecycle under switch](diagrams/blindfold-switch-lifecycle.html) | Activation, refusal, and shutdown |

The JSON source of each diagram sits beside its HTML file. Edit the JSON and rebuild with the `archify` tool; do not edit the HTML.

## What this does

The normal route sends Codex to the gateway with `--config openai_base_url=...`. That works, but the CLI then prints one line on its own `/model` screen:

```
base URL is overridden to http://127.0.0.1:3456/v1. Selecting models may not be supported or work properly.
```

No configuration key removes that line. The line exists to report an overridden base URL, so the only way to remove it is to stop overriding the base URL.

Blindfold mode does that. Codex keeps its official endpoint. The switcher intercepts one layer lower, at the network hop. The configuration file of Codex stays unchanged.

## How it works

Codex reads the `HTTPS_PROXY` variable. In blindfold mode the switcher points that variable at `blindfold/blindfold.mjs`. Codex then sends `CONNECT chatgpt.com:443` to that process.

The process answers the CONNECT itself. It ends the TLS session with a leaf certificate for the target host, and it forwards the Codex API calls to the gateway. Three rules decide where each request goes:

| Request | Destination |
| --- | --- |
| Target host, path under `/backend-api/codex/` | The local gateway |
| Target host, any other path | The real host, over a new TLS session |
| Another public host | A raw tunnel. The process never reads the bytes. |
| A local or private address | Refused. |

The routing decision reads the **normalized** path, not the text the client sent. Node hands over the request target exactly as written, but the gateway resolves it with `new URL(...)`. A raw-text test would therefore accept a string that the gateway later reads as a different path: `/backend-api/codex/%2e%2e/api/logs` becomes `/api/logs`, which is the gateway's admin API. The decision also requires a segment boundary, so `/backend-api/codex-usage` stays with the host it belongs to.

Sign-in, token refresh and the usage page keep working, because they do not use the Codex API path.

## Why no system change is necessary

Codex reads a custom certificate authority from the `CODEX_CA_CERTIFICATE` variable. The private CA stays in the repository. Three things that other interception guides ask for are not necessary here:

- No certificate in the Windows or macOS trust store.
- No line in the `hosts` file, so no administrator rights.
- No change to `~/.codex/config.toml`.

To stop the interception, run `switch off`. Nothing remains on the machine.

## Before you start

You need:

- Node.js 18.17 or later.
- `openssl`. Windows users have it with Git for Windows. Run the script from Git Bash.
- A gateway profile for Codex that already works in the normal route.

## Procedure

### 1. Build the certificates

Run this command in the repository root:

```bash
bash blindfold/make-certs.sh chatgpt.com
```

The script writes `blindfold/certs/ca.pem` and `blindfold/certs/leaf.pem`. It prints the extended key usage and the subject alternative name of the leaf. Make sure that the output contains `TLS Web Server Authentication`.

CAUTION: Do not build these certificates with `New-SelfSignedCertificate` in PowerShell. That command writes a leaf without the `serverAuth` extended key usage, and a strict client refuses it with `unsuitable certificate purpose`.

`blindfold/certs/` is in `.gitignore`. The private keys never enter the repository history.

### 2. Turn on blindfold mode in the profile

Add two keys to the Codex profile in `config.json`:

```json
"blindfold": true,
"blindfoldPort": 3457
```

`blindfoldPort` is optional. The default is 3457.

### 3. Activate the profile

```bash
switch codex <your-profile>
```

This one command starts the gateway, starts the interceptor on the configured port, and writes the environment files. `switch off` stops both and removes the generated files.

If the CA is missing, `switch` refuses the activation and writes no file. That refusal is deliberate: blindfold mode replaces the base URL override with `HTTPS_PROXY`, so a half-applied state would point Codex at a port where nothing listens, and Codex would then reach no host at all.

The environment now holds `HTTPS_PROXY`, `NO_PROXY` and `CODEX_CA_CERTIFICATE` in `env-codex.cmd` and `env-codex.sh`. Only the Codex shim loads those two files. They are separate from `env.cmd` and `env.sh` on purpose: the `claude` shim loads the shared files, and a Codex-only proxy would otherwise capture every `claude` HTTPS call.

The shared files no longer hold `LLM_SWITCHER_CODEX_BASE_URL`, so the shim adds no base URL override.

### 4. Verify the route

Run Codex and open `/model`. The screen shows the official model names, and the override line is gone.

To test without Codex, ask the gateway for its model list through the proxy:

```bash
node -e "
const http=require('http'),tls=require('tls'),fs=require('fs');
const ca=fs.readFileSync('blindfold/certs/ca.pem');
const r=http.request({host:'127.0.0.1',port:3457,method:'CONNECT',path:'chatgpt.com:443'});
r.end();
r.on('connect',(res,socket)=>{
  const s=tls.connect({socket,servername:'chatgpt.com',ca},()=>{
    s.write('GET /backend-api/codex/models HTTP/1.1\r\nHost: chatgpt.com\r\nConnection: close\r\n\r\n');
  });
  s.on('data',d=>process.stdout.write(d));
});
"
```

The answer is the model list of the gateway. Change the path to `/backend-api/codex/%2e%2e/api/logs` and the answer comes from chatgpt.com instead, which proves the normalization.

NOTE: On Windows, `curl` uses the Schannel TLS backend. Schannel ignores `--cacert` for this test and reports error 60. Use the Node command above instead.

## Record what a client sends

Add `--capture <dir>` to write one JSON file per intercepted exchange:

```bash
node blindfold/blindfold.mjs --capture ./captures
```

Each file holds the method, the URL, both header sets and both bodies, truncated
at 200000 characters. Use it to learn what a genuine CLI or IDE puts on the wire.

Both routes are recorded: the calls that go to the gateway, and the calls that are
re-originated to the real host. A compressed body is decoded first, because a
client asks for `gzip` and the bytes on the wire are not readable text. The
forwarded response keeps its original bytes; only the copy in the file is decoded.

To record a different tool, point the proxy at that tool's host and give it a
prefix that no path can match, so every request is re-originated and recorded:

```bash
bash blindfold/make-certs.sh api.anthropic.com ~/.llm-switcher/anthropic/certs
node blindfold/blindfold.mjs --host api.anthropic.com --prefix /no-gateway \
  --port 3458 --certs ~/.llm-switcher/anthropic/certs --capture ~/.llm-switcher/anthropic/captures
```

Use directories that you own. `make-certs.sh` and `--capture` refuse a directory that another
account owns, because that account could read the key or the captures.

Then start the tool with `HTTPS_PROXY=http://127.0.0.1:3458` and the CA in the
variable that the tool reads. A Node client reads `NODE_EXTRA_CA_CERTS`. Set both
variables for that process only; a variable set for one process does not change a
process that already runs.

Credential headers never reach the file. `authorization`, `proxy-authorization`,
`cookie`, `set-cookie`, `x-api-key` and `api-key` are replaced with `<redacted>`,
and so are the account identifiers `chatgpt-account-id`, `openai-organization` and
`x-goog-user-project`. The header names stay, so the shape of the request is still
readable.

CAUTION: The redaction covers headers only. Both bodies are written as they
travelled, so a capture holds your prompts, your source code and the answers of
the model. `captures/` is in `.gitignore`. If you capture somewhere else, add that
path to `.gitignore` before you commit.

The proxy creates the capture directory with mode 0700 and each file with mode 0600.

NOTE: WebSocket sessions are recorded too. Each session gives one file, with every
message in order, and the proxy updates the file while the session runs. Codex sends
its completions over a WebSocket, so these files hold the full conversation.

## How to go back

1. Set `"blindfold": false` in the profile.
2. Run `switch codex <your-profile>` again.

The switcher writes `LLM_SWITCHER_CODEX_BASE_URL` again, stops the interceptor, and Codex returns to the normal route.

## Limits

Read this section before you turn blindfold mode on.

**The CA is trusted for every host, not only the intercepted one.** `CODEX_CA_CERTIFICATE` adds this authority to the trust store that Codex uses for all of its HTTPS calls. The certificate carries no name constraints. Anybody who can read `blindfold/certs/ca.key` can therefore forge a certificate for any host that Codex contacts, not only for `chatgpt.com`. Keep that directory private, and build new certificates if the key leaks.

**All traffic to the intercepted host is decrypted by this process.** That includes sign-in and token refresh, because the CONNECT for the whole host is terminated locally. Requests outside the Codex API path are re-originated to the real host over a new TLS session; they are forwarded, not tunneled. The `--verbose` flag prints the method and path of every such request.

**Directory permissions are weaker on Windows.** `make-certs.sh` calls `chmod` on the certificate directory, and that call does nothing under Git Bash for Windows. On that platform the keys are protected only by the account that owns the directory.

**Only one host is intercepted.** If your Codex uses API key authentication instead of ChatGPT authentication, the host is `api.openai.com`. Build the leaf for that host, and start the process with `--host api.openai.com --prefix /v1`.

**The interceptor is a proxy.** It binds to loopback, so a remote machine cannot use it, but every process on this machine can. It refuses a CONNECT to a local or private address, so it cannot be used to reach a service that listens only on this machine.

**Some `--config` keys still travel.** Blindfold mode removes the base URL override only. The switcher still passes `model_catalog_json` and the two context window keys, because those carry no address and no internal name.
