# Freestyle tailnet repro

This repo is a minimal reproduction for Freestyle VM networking behavior with Tailscale and Headscale.

The main issue: Freestyle VMs can run `tailscaled` in userspace mode, and Headscale can run on a Freestyle VM, but normal kernel TUN networking does not appear to be available. That prevents a standard `tailscale0` interface and normal VM-to-VM service networking.

Observed on May 22, 2026:

- `/dev/net/tun` is absent by default.
- Creating `/dev/net/tun` with `mknod` succeeds, but `TUNSETIFF` fails with `OSError: [Errno 19] No such device`.
- `modprobe tun` does not make TUN usable.
- `tailscaled --tun=userspace-networking` starts.
- A Headscale control server can run on a Freestyle control VM and be reached at `https://<vmId>.vm.freestyle.sh`.
- On a plain Freestyle VM, port `8080` may already be occupied, so this repro maps external HTTPS `443` to internal `18080`.
- Two worker VMs can join that Headscale server with userspace Tailscale.
- `tailscale ping` succeeds through DERP.
- Direct peer connection is not established.

## Run

```bash
npm install
export FREESTYLE_API_KEY=...
npm run tun
npm run headscale
```

Both scripts create disposable Freestyle VMs and delete them in `finally` blocks.

## Expected question for Freestyle

Can Freestyle VMs support `/dev/net/tun` and the kernel support needed for Tailscale/WireGuard-style interfaces?

If not, is the recommended product architecture to use userspace networking plus app-level proxies/relays rather than normal tailnet interfaces?
