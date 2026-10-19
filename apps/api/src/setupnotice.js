// The first administrator is created in the dashboard, behind a setup token that was generated on first run. It is shown in the API log (the
// way many self-hosted tools print their first-run password), once the API is up and only while nobody has set up yet.
export function setupTokenNotice({ token, hasAdmin }) {
  if (hasAdmin || !token) return null;
  return [
    "First run: open the dashboard and create the administrator.",
    `The setup token to enter there is: ${token}`,
    "(It is only asked for until the administrator exists. Find it again with: docker compose logs api)",
  ].join("\n");
}
