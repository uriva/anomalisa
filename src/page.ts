const htmlEntities: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export const escapeHtml = (value: string | number) =>
  String(value).replace(/[&<>"']/g, (char) => htmlEntities[char] ?? char);

const baseStyles = `
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0a; color: #e0e0e0; margin: 0; padding: 1rem; }
    .card { background: #141414; border: 1px solid #222; border-radius: 12px; max-width: 480px; width: 100%; padding: 2rem; box-shadow: 0 4px 20px rgba(0,0,0,0.5); text-align: center; margin: 0 auto; }
    .brand { font-size: 0.75rem; color: #71717a; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; margin-bottom: 1.25rem; }
    h1 { font-size: 1.25rem; color: #fff; margin: 0 0 0.35rem 0; font-weight: 600; word-break: break-word; }
    p { color: #888; font-size: 0.9rem; }
    a { color: #7eb8ff; text-decoration: none; }
    code { font-family: monospace; background: #1f1f1f; color: #e4e4e7; padding: 0.15rem 0.35rem; border-radius: 4px; font-size: 0.85em; }
    .details { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px; padding: 0.75rem 1rem; margin-bottom: 1.5rem; text-align: left; }
    .detail-row { display: flex; justify-content: space-between; font-size: 0.85rem; padding: 0.35rem 0; border-bottom: 1px solid #222; gap: 0.5rem; }
    .detail-row:last-child { border-bottom: none; }
    .label { color: #888; flex-shrink: 0; }
    .val { color: #eee; font-family: monospace; word-break: break-all; }
    .btn-primary { display: block; width: 100%; padding: 0.7rem 1rem; border-radius: 6px; font-size: 0.9rem; font-weight: 600; text-align: center; text-decoration: none; background: #27272a; color: #ffffff; border: 1px solid #3f3f46; transition: background 0.15s, border-color 0.15s; }
    .btn-primary:hover { background: #3f3f46; border-color: #52525b; text-decoration: none; }
    .home-link { display: inline-block; font-size: 0.85rem; color: #7eb8ff; text-decoration: none; }
    .home-link:hover { text-decoration: underline; }
    @media (max-width: 480px) {
      body { padding: 0.75rem; }
      .card { padding: 1.25rem 1rem; border-radius: 8px; }
    }
`;

export const centerPageStyles = `
    body { display: flex; align-items: center; justify-content: center; min-height: 100vh; }
`;

export const renderPage = ({
  title,
  body,
  styles,
  script,
}: {
  title: string;
  body: string;
  styles?: string;
  script?: string;
}) =>
  `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
${baseStyles}${styles ?? ""}
  </style>
</head>
<body>
${body}
${script ?? ""}
</body>
</html>`;
