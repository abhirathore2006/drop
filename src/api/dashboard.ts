// SPA shell for the Drop admin console. The React app is bundled to /ui/app.js (esbuild
// browser target in build.mjs) and calls /v1/* with the session cookie. Kept as a tiny shell
// so the heavy UI lives in a static asset, not inline in the API bundle.
export function dashboardHtml(_baseDomain: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>drop · console</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
<div id="root"></div>
<script src="/ui/app.js"></script>
</body>
</html>`;
}
