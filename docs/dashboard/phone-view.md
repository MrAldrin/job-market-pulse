# Optional phone view

<span id="private-phone-view"></span>

Use [Tailscale Serve](#open-the-local-dashboard-through-tailscale-serve) to open
the local dashboard without uploading. Use [Railway](#open-on-your-phone) if you
want a hosted, read-only copy of saved results. Neither option is required to
run Pulse locally. See the [app guide](new-dashboard.md) for page behavior and limits.

## Open on your phone

For the hosted option, set up the [Railway viewer](../operations/railway.md)
and [snapshot upload](../operations/phone-snapshots.md). Use the Railway link
and owner login. The private URL and credentials
are not recorded here. After sign-in, the start page
redirects to `/app/`; the old `/dashboard` pages have no fallback address.
The [Settings page](new-dashboard.md#captured-settings) is read-only and needs
snapshot v3 or later. V4 and later show home location and the comparison profile.
It has offline verification only. For service access and approval
gates, see [Railway operations](../operations/railway.md#typescript-build).


<span id="option-a-tailscale-at-home"></span>

## Open the local dashboard through Tailscale Serve

This is an optional private route to the writable dashboard on your PC.
It is separate from Railway. You can use feedback, settings, helpers and
Run from the phone. Run still needs confirmation. The PC must stay awake,
connected to Tailscale, and running Pulse.

Do this only after you approve private network access. Use [Tailscale
Serve](https://tailscale.com/kb/1312/serve) as the **only** trusted local proxy.
Do not use Funnel, publish the Pulse port, or point any other proxy or tunnel
at it. Restrict access to this machine and HTTPS port in your tailnet policy.
Devices must be signed in as the configured owner. A shared or tagged device
that supplies no owner identity cannot open the dashboard.

1. On the PC, use `tailscale serve status` and `tailscale funnel status`. Do not
   replace an existing route or use a port that Funnel exposes. Use the
   machine's full HTTPS name in the tailnet. The values below are examples.
2. Start the selected writable profile from a built checkout or installed
   CLI. Put the exact HTTPS origin in `--serve-origin`, with no trailing
   slash or path. Put the exact Tailscale login name in `--serve-owner`.

   ```sh
   pulse dashboard --port 8770 --serve-origin 'https://dashboard.example' --serve-owner 'owner@example.com'
   ```

3. In another terminal on the PC, forward the HTTPS root to the same loopback
   port. Verify that Serve reports the expected name and no public route.

   ```sh
   tailscale serve --bg --https=443 http://127.0.0.1:8770
   tailscale serve status
   ```

4. From the signed-in phone, open `https://dashboard.example/app/`, using your
   actual name. Confirm that a device signed in as a different user cannot
   open the page. Use the same phone URL in **Settings → Phone notifications**
   if you want ntfy to link here. The ntfy URL does not grant inbound access.
5. To stop this route, use `tailscale serve --https=443 off` for the Serve
   listener you added. Stop Pulse with Ctrl-C.

Pulse still binds only to loopback. Serve strips client-supplied identity
headers and sets `Tailscale-User-Login` from the authenticated Tailscale user
when that identity is available. Pulse checks the native loopback socket, the
exact Host and origin, the HTTPS marker (`X-Forwarded-Proto: https`), and that
login. It does not use a forwarded IP as identity. Do not let an untrusted local service connect to this listener
on behalf of remote users. Pulse cannot verify which local process sent the
headers. Direct local HTTP remains available and does not use Serve headers.

Offline tests use a simulated proxy. They do not verify live access,
tailnet policy, phone behavior or notification delivery.

## Persistent phone shortlist

Home displays the snapshot's captured shortlist in its saved selection order.
Just looking selects Exceptional; Actively looking also selects Strong. Saved
history can include source-unconfirmed jobs, labelled as such; it is not a fresh
digest eligibility check. Recapture applies the current mode. Possible
matches and closed history remain available through Jobs. The update time is
the snapshot capture time, not a live source check.
See [Home and Jobs](new-dashboard.md#implemented-status).
The old HTML shortlist and bundle remain stored data but are not served.

## Shortlist feedback

Use the local dashboard, also when you access it over Tailscale, for Save,
Good match and Not for me. See [local feedback](new-dashboard.md#local-feedback).
The read-only Railway copy has no feedback controls or Saved filter.

## If something goes wrong

- **No snapshot yet:** capture and upload a dashboard row with JSON.
  Old HTML-only rows are retained but cannot supply app data.
- **Jobs look old:** check the update time and use the
  [refresh guide](../operations/phone-snapshots.md).

## Related operations

Routine viewing needs none of the deployment commands. Use these guides only
when you need to refresh data or run the service.

<span id="capture-and-publish-a-full-dashboard-snapshot"></span>
<span id="latest-staged-digest"></span>
<span id="digest-only-compatibility"></span>
- [Capture and publish snapshots](../operations/phone-snapshots.md), including legacy digest handling.

<span id="shared-core"></span>
<span id="single-file-loopback-viewer-brief"></span>
- [Viewer technical reference](../operations/phone-snapshots.md).

<span id="option-b-railway"></span>
<span id="release-and-manual-acceptance"></span>
- [Railway deployment and acceptance](../operations/railway.md).

<span id="status"></span>
- See [scope](../scope.md#implemented-capabilities-and-verification-limits) for current verification limits.
