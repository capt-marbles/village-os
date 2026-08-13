export const ownedFixtureOrigin = "https://fixture.village.test" as const;

export function renderOwnedFixtureLogin(): string {
  return '<form method="post" action="/login"><input name="username" autocomplete="username"><input name="password" type="password" autocomplete="current-password"><button type="submit">Sign in</button></form>';
}

export function createOwnedFixtureLoginRequest(
  username: string,
  password: string,
) {
  return {
    url: `${ownedFixtureOrigin}/login`,
    method: "POST" as const,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password }).toString(),
  };
}
