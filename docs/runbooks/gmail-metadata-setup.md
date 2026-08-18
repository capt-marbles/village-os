# Gmail metadata setup

Village's first Gmail capability is deliberately read-only and metadata-only. It
can review up to 25 recent unread inbox items using the sender, subject, received
time, unread state, and Gmail labels. It does not request message bodies,
attachments, drafts, sends, label changes, or other mailbox mutations.
Ranking is deterministic and local; Gmail metadata is not sent to ChatGPT.

## Development setup

1. In a development-only Google Cloud project, enable the Gmail API.
2. Configure the OAuth consent screen and add the owner account as a test user.
3. Create an OAuth client with application type **Desktop app**.
4. Launch Village with the client ID available to the Electron main process:

   ```sh
   VILLAGE_GOOGLE_OAUTH_CLIENT_ID="your-client.apps.googleusercontent.com" \
     pnpm --filter @village/desktop preview:ritual-builder
   ```

The client ID is public application configuration, not a secret. Do not package
a web-client secret. Village opens Google's authorization page in the system
browser and receives the result on a random `127.0.0.1` loopback port using PKCE.

## Expected ceremony

- The Ritual Builder shows **Connect Gmail**.
- Google asks for the restricted `gmail.metadata` scope.
- After consent, the browser says Gmail is connected and Village shows the
  connected address.
- The refresh grant is stored through macOS Keychain-backed secure storage.
  Access tokens remain in main-process memory and never cross renderer IPC.
- Disconnect revokes the Google grant where reachable and always removes the
  local grant.

Projects in Google's Testing publishing state issue short-lived Gmail refresh
grants. Reconnection during development is expected. Public distribution is
blocked on Google's restricted-scope verification and security-review process;
passing local tests is not release approval.
