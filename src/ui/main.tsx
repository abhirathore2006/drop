import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";

const css = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#0b0d10;color:#e7e9ea}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.86em;background:#11151a;padding:1px 5px;border-radius:5px;border:1px solid #1c2128}
.muted{color:#8a9099}
button{font:inherit;cursor:pointer}
.spin{padding:40px;color:#8a9099}.spin.big{text-align:center;margin-top:80px}

/* header */
header{display:flex;align-items:center;justify-content:space-between;padding:18px 28px;border-bottom:1px solid #1c2128;position:sticky;top:0;background:#0b0d10cc;backdrop-filter:blur(6px);z-index:5}
.brand{font-weight:700;font-size:19px;letter-spacing:-.01em}.tri{color:#9be15d}
.tag{font-size:11px;color:#8a9099;border:1px solid #2a2f37;border-radius:6px;padding:2px 7px;margin-left:6px;font-weight:500;vertical-align:middle}
nav{display:flex;align-items:center;gap:18px}
.navlink{background:none;border:0;color:#8a9099;text-decoration:none;font-size:14px}
.navlink.on,.navlink:hover{color:#e7e9ea}
.who{color:#8a9099;font-size:13px}

main{max-width:1080px;margin:0 auto;padding:28px}
h2{font-size:14px;text-transform:uppercase;letter-spacing:.08em;color:#8a9099;margin:28px 0 12px;font-weight:600}
h2 .count{background:#11151a;border:1px solid #2a2f37;border-radius:20px;padding:1px 8px;font-size:11px;margin-left:6px;color:#8a9099}

/* cards */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
.card{text-align:left;background:#11151a;border:1px solid #1c2128;border-radius:14px;padding:16px 18px;transition:border-color .12s,transform .12s}
.card:hover{border-color:#3a4150;transform:translateY(-1px)}
.card-top{display:flex;align-items:center;gap:9px}
.dot{width:8px;height:8px;border-radius:50%;background:#9be15d;box-shadow:0 0 8px #9be15d66}
.card-name{font-weight:600;font-size:16px;flex:1}
.card-owner{color:#8a9099;font-size:13px;margin:8px 0 14px}
.card-foot{display:flex;justify-content:flex-end}
.ver{font-family:ui-monospace,monospace;font-size:12px;color:#6b7280}

/* badges + pills */
.badge{font-size:10px;font-weight:700;letter-spacing:.05em;padding:2px 7px;border-radius:6px;border:1px solid}
.badge-site{color:#7fb4ff;border-color:#2e4d77;background:#16243a}
.badge-app{color:#9be15d;border-color:#3d5e2a;background:#18260f}
.badge-database{color:#c79bff;border-color:#4a357a;background:#221836}
.pill{font-size:11px;font-weight:600;padding:2px 9px;border-radius:20px;border:1px solid}
.pill-ok{color:#9be15d;border-color:#3d5e2a;background:#18260f}
.pill-danger{color:#ff8d8d;border-color:#6e2a2a;background:#2a1414}
.pill-idle{color:#e8c97a;border-color:#6b5a2a;background:#241f10}
.restarts{color:#ff8d8d;font-size:12px}

/* drawer */
.scrim{position:fixed;inset:0;background:#0008;z-index:10}
.drawer{position:fixed;top:0;right:0;height:100vh;width:min(520px,94vw);background:#0e1217;border-left:1px solid #1c2128;overflow-y:auto;padding:24px;z-index:11;box-shadow:-20px 0 50px #0006}
.dhead{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px}
.dname{font-size:20px;font-weight:700;display:flex;align-items:center;gap:10px}
.dhost{display:block;color:#9be15d;font-size:13px;text-decoration:none;margin-top:5px}
.downer{color:#8a9099;font-size:12px;margin-top:3px}
.x{background:none;border:0;color:#8a9099;font-size:18px}.x:hover{color:#e7e9ea}
.sec{border-top:1px solid #1c2128;padding:16px 0}
.sec h3,.sec-h h3{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#8a9099;margin:0 0 10px;font-weight:600}
.sec-h{display:flex;justify-content:space-between;align-items:center}
.kv{display:flex;gap:12px;padding:5px 0;font-size:14px}
.kv .k{color:#8a9099;width:96px;flex-shrink:0}.kv .v{flex:1;word-break:break-word}
.item{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid #14181d}
.item .meta{flex:1}.item b{font-weight:600}.item b.cur{color:#9be15d}.item .sub{color:#8a9099;font-size:12px}
.addrow{display:flex;gap:8px;margin-top:10px}
.addrow input,.adminbar input{flex:1;background:#11151a;border:1px solid #2a2f37;border-radius:8px;padding:8px 11px;color:inherit;font-size:13px}
.logs{background:#08090b;border:1px solid #1c2128;border-radius:8px;padding:12px;font-family:ui-monospace,monospace;font-size:11.5px;line-height:1.5;max-height:280px;overflow:auto;white-space:pre-wrap;color:#cdd2d6;margin:0}
.err{background:#2a1414;border:1px solid #6e2a2a;color:#ff8d8d;border-radius:8px;padding:9px 12px;font-size:13px;margin-bottom:12px}

/* buttons */
.btn{background:#1a1f26;border:1px solid #2a2f37;color:#e7e9ea;border-radius:8px;padding:8px 14px}
.btn:hover:not(:disabled){border-color:#3a4150}
.btn:disabled{opacity:.5;cursor:default}
.btn.sm{padding:5px 11px;font-size:13px}
.btn.primary{background:#9be15d;color:#0b0d10;border:0;font-weight:600;padding:10px 18px}
.btn.danger{color:#ff8d8d;border-color:#6e2a2a}.btn.danger:hover:not(:disabled){background:#2a1414}
.btn.wide{width:100%;margin-top:10px}

/* admin table */
.adminbar{display:flex;align-items:center;gap:12px;margin:28px 0 12px}
.adminbar h2{margin:0;flex:1}
.adminbar select{background:#11151a;border:1px solid #2a2f37;border-radius:8px;padding:8px 11px;color:inherit;font-size:13px}
.tbl{width:100%;border-collapse:collapse;font-size:14px}
.tbl th{text-align:left;color:#8a9099;font-weight:500;font-size:12px;padding:8px 10px;border-bottom:1px solid #1c2128}
.tbl td{padding:10px;border-bottom:1px solid #14181d}.tbl td.right{text-align:right}
.link{background:none;border:0;color:#e7e9ea;font-weight:600;padding:0}.link:hover{color:#9be15d}

.gate{max-width:380px;margin:120px auto;text-align:center}
.gate .brand{font-size:26px;margin-bottom:14px}.gate p{color:#8a9099;margin-bottom:22px}
.empty{margin-top:60px;text-align:center}.empty code{margin:0 3px}
`;

const style = document.createElement("style");
style.textContent = css;
document.head.appendChild(style);

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
