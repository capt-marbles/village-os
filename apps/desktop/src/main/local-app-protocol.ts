import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Protocol } from "electron";

const csp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const indexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <title>Village</title>
    <link rel="stylesheet" href="village://app/styles.css">
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="village://app/renderer.js"></script>
  </body>
</html>`;

const styles = `:root { color-scheme: dark; font-family: ui-sans-serif, system-ui; background: #101410; color: #f2f5ed; }
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; min-height: 100vh; background: radial-gradient(circle at 18% 10%, #283a28, #101410 45%); }
#root { width: 100%; min-width: 360px; height: 100vh; overflow: auto; }
.pairing-mode #root { width: 100%; }
.desktop-workspace { min-width: 360px; min-height: 100vh; overflow: hidden; }
.pairing-bootstrap { width: min(760px, calc(100% - 2rem)); margin: 0 auto; padding: 3rem 0; }
.pairing-bootstrap__eyebrow { color: #a8d48f; font-size: .75rem; font-weight: 800; letter-spacing: .14em; }
.pairing-bootstrap h1 { margin: .35rem 0 1rem; font-size: clamp(2rem, 7vw, 4rem); }
.pairing-bootstrap p { max-width: 68ch; color: #c2cec0; line-height: 1.6; }
.pairing-bootstrap__fingerprint { display: block; margin: .75rem 0 1rem; font: 800 1.15rem ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .08em; }
.pairing-bootstrap pre { overflow: auto; border: 1px solid #445047; border-radius: 14px; padding: 1rem; color: #eff7eb; background: #111711; user-select: all; }
.pairing-bootstrap section { margin-top: 1rem; border: 1px solid #36503a; border-radius: 14px; padding: 1rem; background: #172118; }
.ritual-builder-mode { background: #101510; }
.ritual-builder-mode #root { min-width: 320px; overflow: hidden; }
.ritual-builder { display: grid; grid-template-columns: minmax(440px, 1.08fr) minmax(420px, .92fr); height: 100vh; background: #101510; }
.ritual-conversation { min-width: 0; padding: 0 clamp(1.5rem, 4vw, 4rem) 4rem; overflow-y: auto; }
.ritual-conversation__header { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: 1rem; max-width: 710px; margin: 0 auto; padding: 1rem 0; border-bottom: 1px solid #2d382f; background: rgba(16, 21, 16, .96); backdrop-filter: blur(18px); }
.ritual-steward-identity { display: flex; align-items: center; gap: .75rem; }
.ritual-steward-identity > span { display: grid; place-items: center; width: 2.35rem; height: 2.35rem; border: 1px solid #708a70; border-radius: 50%; color: #dff3d2; background: #243126; font: 600 1.15rem "Iowan Old Style", serif; }
.ritual-steward-identity .ritual-eyebrow { margin-bottom: .1rem; font-size: .56rem; }
.ritual-steward-identity h1 { margin: 0; font: 600 1rem ui-sans-serif, system-ui; letter-spacing: -.01em; }
.ritual-steward-status { display: flex; align-items: center; gap: .45rem; margin: 0; color: #9cac9a; font-size: .68rem; font-weight: 750; }
.ritual-steward-status > span { width: .5rem; height: .5rem; border-radius: 50%; background: #9fd781; box-shadow: 0 0 0 4px rgba(159, 215, 129, .1); }
.ritual-welcome { max-width: 710px; margin: clamp(2.5rem, 7vh, 5rem) auto 2.5rem; }
.ritual-welcome h2 { max-width: 640px; margin: 0; font-family: "Iowan Old Style", "Palatino Linotype", Palatino, serif; font-size: clamp(2.7rem, 5.5vw, 5.2rem); font-weight: 500; letter-spacing: -.045em; line-height: .95; }
.ritual-welcome > p:last-child { max-width: 570px; margin: 1.2rem 0 0; color: #b9c5b6; font-size: 1rem; line-height: 1.65; }
.ritual-eyebrow { margin: 0 0 .7rem; color: #a8d48f; font-size: .7rem; font-weight: 850; letter-spacing: .17em; text-transform: uppercase; }
.ritual-desk-tools { display: grid; gap: .75rem; margin-bottom: 1.4rem; padding-bottom: 1.4rem; border-bottom: 1px solid #b8c1b3; }
.ritual-automation { margin: 0; border: 1px solid #aeb9a9; border-radius: 1rem; padding: 1rem; background: #e4e9da; box-shadow: none; }
.ritual-automation > header { display: flex; align-items: start; justify-content: space-between; gap: 1rem; }
.ritual-automation h2 { margin: 0; font: 500 1.55rem "Iowan Old Style", serif; }
.ritual-automation > header > span, .ritual-inbox-list > li > span { border-radius: 999px; padding: .32rem .5rem; color: #526055; background: #d3dbc9; font: 800 .58rem ui-monospace, monospace; letter-spacing: .06em; text-transform: uppercase; }
.ritual-automation > header > span:not(:only-child) { flex: 0 0 auto; }
.ritual-schedule { display: grid; grid-template-columns: minmax(0, 1fr) 8rem auto auto; gap: .55rem; align-items: end; margin-top: .9rem; }
.ritual-schedule label { display: grid; gap: .3rem; color: #647167; font-size: .65rem; font-weight: 800; text-transform: uppercase; }
.ritual-schedule select, .ritual-schedule input { min-height: 36px; border: 1px solid #9ba79a; border-radius: .65rem; padding: .45rem .6rem; color: #263129; background: #f5f5e9; color-scheme: light; }
.ritual-schedule button { min-height: 36px; border: 1px solid #718f67; border-radius: 999px; padding: .45rem .7rem; color: #132011; background: #b8e19f; font-size: .7rem; font-weight: 800; cursor: pointer; }
.ritual-schedule button[type="button"] { color: #354438; background: transparent; }
.ritual-schedule small { grid-column: 1 / -1; color: #68766a; }
.ritual-inbox-list { display: grid; gap: .55rem; margin: .9rem 0 0; padding: .8rem 0 0; border-top: 1px solid #334436; list-style: none; }
.ritual-inbox-list li { display: grid; grid-template-columns: auto 1fr; gap: .7rem; align-items: center; }
.ritual-inbox-list > li > span.needs-attention { color: #f0d8a5; background: #4a3922; }
.ritual-inbox-list div { display: grid; gap: .15rem; min-width: 0; }
.ritual-inbox-list strong { overflow: hidden; color: #2d392f; font-size: .78rem; text-overflow: ellipsis; white-space: nowrap; }
.ritual-inbox-list small, .ritual-automation__empty { color: #68766a; font-size: .68rem; }
.ritual-automation [role="alert"] { color: #8d382d; font-size: .72rem; }
.ritual-tool { display: grid; grid-template-columns: 2.65rem minmax(0, 1fr); gap: .9rem; margin: 0; border: 1px solid #b2bcad; border-radius: 1rem; padding: .9rem; background: #f5f5e9; box-shadow: none; }
.ritual-tool__mark { display: grid; place-items: center; width: 2.65rem; height: 2.65rem; border: 1px solid #7ea26d; border-radius: 50%; color: #d7f0c6; background: #213222; font: 600 1.2rem "Iowan Old Style", serif; }
.ritual-tool__body { min-width: 0; }
.ritual-tool__heading { display: flex; align-items: start; justify-content: space-between; gap: .75rem; }
.ritual-tool__eyebrow { margin: 0 0 .18rem !important; color: #91ac87 !important; font-size: .62rem !important; font-weight: 850; letter-spacing: .13em; line-height: 1.3 !important; text-transform: uppercase; }
.ritual-tool h2 { margin: 0; color: #263129; font-size: .98rem; }
.ritual-tool p { margin: .45rem 0 0; color: #68766a; font-size: .78rem; line-height: 1.5; }
.ritual-tool__status { flex: 0 0 auto; border: 1px solid #9daa9d; border-radius: 999px; padding: .3rem .48rem; color: #647267; font: 800 .56rem ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; }
.ritual-tool__status--saved { border-color: #718f67; color: #c8e8b6; background: #213222; }
.ritual-tool__form { display: grid; gap: .45rem; margin-top: .8rem; }
.ritual-tool__form label { color: #d5dfd0; font-size: .72rem; font-weight: 750; }
.ritual-tool__form input { width: 100%; border: 1px solid #506153; border-radius: .72rem; padding: .7rem .8rem; color: #f2f5ed; background: #0f1510; font: .82rem ui-monospace, SFMono-Regular, Menlo, monospace; }
.ritual-tool__actions { display: flex; flex-wrap: wrap; gap: .45rem; margin-top: .7rem; }
.ritual-tool__actions button { min-height: 34px; border: 1px solid #879688; border-radius: 999px; padding: .42rem .7rem; color: #354438; background: transparent; font: 750 .68rem ui-sans-serif, system-ui; cursor: pointer; }
.ritual-tool__actions .ritual-tool__action--primary { border-color: #90b57f; color: #132011; background: #b8e19f; }
.ritual-tool__error { color: #f1b5aa !important; }
.ritual-messages { display: grid; gap: 1.15rem; max-width: 710px; margin: 0 auto; padding: 0; list-style: none; }
.ritual-message { display: grid; grid-template-columns: 5rem 1fr; gap: 1rem; align-items: start; }
.ritual-message > span { padding-top: .18rem; color: #7f9180; font-size: .68rem; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
.ritual-message p { margin: 0; color: #e9eee5; line-height: 1.62; }
.ritual-message--owner p { justify-self: end; max-width: 86%; padding: .8rem 1rem; border: 1px solid #405242; border-radius: 1rem 1rem .25rem 1rem; background: #1a231b; }
.ritual-start { max-width: 710px; margin: 2rem auto 0; }
.ritual-start__choices { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .7rem; margin: 0; border: 0; padding: 0; }
.ritual-start__choices legend { grid-column: 1 / -1; margin-bottom: .2rem; color: #cbd7c7; font-size: .82rem; font-weight: 750; }
.ritual-start__choices button { display: grid; grid-template-columns: 2.3rem 1fr; gap: .15rem .7rem; min-height: 92px; border: 1px solid #3a4b3c; border-radius: 1rem; padding: .85rem; color: #edf2e9; background: #151c16; text-align: left; cursor: pointer; }
.ritual-start__choices button[aria-pressed="true"] { border-color: #9cc985; background: #1d2b1e; box-shadow: inset 0 0 0 1px #6f9462; }
.ritual-start__choices button > span { grid-row: span 2; display: grid; place-items: center; width: 2.3rem; height: 2.3rem; border: 1px solid #66806a; border-radius: 50%; color: #b8e19f; font: 750 .66rem ui-monospace, monospace; }
.ritual-start__choices button strong { align-self: end; font-size: .86rem; }
.ritual-start__choices button small { color: #91a090; line-height: 1.35; }
.ritual-start .ritual-composer { margin-top: 1rem; }
.ritual-composer, .ritual-decisions { max-width: 710px; margin: 2rem auto 0; border: 0; padding: 0; }
.ritual-composer label, .ritual-decisions legend { display: block; margin-bottom: .75rem; color: #cbd7c7; font-size: .82rem; font-weight: 750; }
.ritual-composer textarea, .ritual-composer input { width: 100%; resize: vertical; border: 1px solid #405242; border-radius: 1rem; padding: 1rem 1.1rem; color: #f2f5ed; background: #151c16; font: inherit; line-height: 1.5; }
.ritual-composer button, .ritual-approval button { min-height: 46px; margin-top: .8rem; border: 0; border-radius: 999px; padding: .7rem 1.15rem; color: #11200f; background: #b8e19f; font: 800 .84rem ui-sans-serif, system-ui; cursor: pointer; }
.ritual-composer > p { margin: .65rem 0 0; color: #8fa08e; font-size: .76rem; line-height: 1.45; }
.ritual-test-composer p { margin: .55rem 0 0; color: #8fa08e; font-size: .76rem; line-height: 1.45; }
.ritual-decisions > div { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .75rem; }
.ritual-decisions button { display: grid; grid-template-columns: 2rem 1fr; gap: .2rem .7rem; min-height: 116px; border: 1px solid #3a4b3c; border-radius: 1rem; padding: .9rem; color: #edf2e9; background: #151c16; text-align: left; cursor: pointer; transition: border-color 160ms ease, transform 160ms ease, background 160ms ease; }
.ritual-decisions button:hover { border-color: #9cc985; background: #1b261c; transform: translateY(-2px); }
.ritual-decisions button > span { grid-row: span 2; display: grid; place-items: center; width: 2rem; height: 2rem; border: 1px solid #66806a; border-radius: 50%; color: #b8e19f; font: 750 .7rem ui-monospace, monospace; }
.ritual-decisions button strong { align-self: end; font-size: .9rem; }
.ritual-decisions button small { color: #91a090; line-height: 1.35; }
.ritual-draft { min-width: 0; max-height: 100vh; overflow-y: auto; border-left: 1px solid #445043; padding: clamp(1.25rem, 2.5vw, 2.5rem); color: #243026; background: #eef0df; box-shadow: -20px 0 70px rgba(0, 0, 0, .24); }
.ritual-draft__header { display: flex; gap: 1.25rem; align-items: start; justify-content: space-between; padding-bottom: 1.4rem; border-bottom: 2px solid #314034; }
.ritual-draft .ritual-eyebrow { color: #59705c; }
.ritual-draft h2 { margin: 0; max-width: 480px; font-family: "Iowan Old Style", "Palatino Linotype", Palatino, serif; font-size: clamp(2rem, 3.5vw, 3.5rem); font-weight: 500; letter-spacing: -.035em; line-height: 1; }
.ritual-revision { flex: 0 0 auto; border: 1px solid #829084; border-radius: 999px; padding: .42rem .68rem; color: #47594a; font: 750 .64rem ui-monospace, monospace; letter-spacing: .05em; text-transform: uppercase; }
.ritual-charter { display: grid; gap: .7rem; padding: 1.5rem 0 4rem 1.35rem; border-left: 1px solid #b6beae; }
.ritual-charter > label, .ritual-field > span, .ritual-field-heading > span { color: #657568; font-size: .66rem; font-weight: 850; letter-spacing: .13em; text-transform: uppercase; }
.ritual-charter > input, .ritual-charter > textarea { width: 100%; border: 0; border-bottom: 1px solid #b4bdaf; border-radius: 0; padding: .25rem 0 .7rem; color: #1d2920; background: transparent; font: 600 1rem ui-sans-serif, system-ui; line-height: 1.5; resize: vertical; }
.ritual-charter > input:disabled, .ritual-charter > textarea:disabled { opacity: 1; color: #1d2920; -webkit-text-fill-color: #1d2920; }
.ritual-charter > label:not(:first-child), .ritual-field, .ritual-charter > section { margin-top: 1rem; }
.ritual-field { display: grid; gap: .35rem; padding-bottom: 1rem; border-bottom: 1px solid #c6ccbf; }
.ritual-field strong { font-size: .98rem; }
.ritual-field small { color: #667269; line-height: 1.45; }
.ritual-field-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: .75rem; }
.ritual-field-heading small { color: #728077; }
.ritual-step-list { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
.ritual-step-list li { display: grid; grid-template-columns: 2rem 1fr; gap: .75rem; padding: 1rem 0; border-top: 1px solid #c6ccbf; }
.ritual-step-list li > span { color: #748178; font: 750 .68rem ui-monospace, monospace; }
.ritual-step-list strong { display: block; }
.ritual-step-list p { margin: .3rem 0; color: #566259; font-size: .86rem; line-height: 1.5; }
.ritual-step-list small { color: #617664; font-weight: 700; }
.ritual-approval { margin-top: 1.25rem; border: 1px solid #82947f; border-radius: 1rem; padding: 1rem; background: #e3e9d8; }
.ritual-approval p { margin: 0; color: #435047; font-size: .83rem; line-height: 1.5; }
.ritual-approved { margin-top: 1.25rem; border-left: 4px solid #567e4f; padding: .5rem 0 .5rem 1rem; }
.ritual-approved p { margin: .35rem 0 0; color: #536057; }
.ritual-approved button, .ritual-receipt button { min-height: 40px; margin: .8rem .45rem 0 0; border: 1px solid #617562; border-radius: 999px; padding: .6rem .9rem; color: #263429; background: transparent; font: 800 .76rem ui-sans-serif, system-ui; cursor: pointer; }
.ritual-approved button:first-of-type, .ritual-receipt button:first-of-type { border-color: #38523a; color: #f3f7ed; background: #38523a; }
.ritual-receipt { margin-top: 1.4rem; border: 1px solid #8c9986; border-radius: 1.1rem; padding: 1.15rem; background: #f6f4e7; box-shadow: 0 16px 40px rgba(46, 58, 45, .1); }
.ritual-receipt > header { display: flex; align-items: start; justify-content: space-between; gap: 1rem; padding-bottom: .9rem; border-bottom: 1px solid #c7ccbd; }
.ritual-receipt h3 { margin: 0; font: 500 1.75rem "Iowan Old Style", serif; }
.ritual-receipt > header > span { border-radius: 999px; padding: .35rem .55rem; color: #5d4930; background: #eadbb3; font: 800 .62rem ui-monospace, monospace; text-transform: uppercase; }
.ritual-receipt__summary { margin: 1rem 0; color: #1f2b22; font: 600 1rem/1.55 ui-sans-serif, system-ui; }
.ritual-receipt__proof { display: grid; grid-template-columns: auto 1fr; gap: .4rem .8rem; border-block: 1px solid #c7ccbd; padding: .85rem 0; }
.ritual-receipt__proof span { color: #68746b; font: 800 .62rem ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; }
.ritual-receipt__proof code, .ritual-receipt__proof strong { justify-self: end; font-size: .75rem; }
.ritual-receipt h4 { margin: 1rem 0 .4rem; color: #607063; font-size: .65rem; letter-spacing: .1em; text-transform: uppercase; }
.ritual-receipt ul { margin: 0; padding-left: 1.1rem; color: #37433a; font-size: .82rem; line-height: 1.55; }
.ritual-receipt__uncertainty { border-left: 3px solid #b38c50; padding-left: .8rem; }
.ritual-learning-pending { margin-top: 1.4rem; border: 1px dashed #8c9986; border-radius: 1rem; padding: 1rem; }
.ritual-learning-pending strong { display: block; margin-bottom: .35rem; }
.ritual-learning { margin-top: 1.4rem; border: 1px solid #718574; border-radius: 1.1rem; padding: 1.15rem; background: #f6f4e7; box-shadow: 0 16px 40px rgba(46, 58, 45, .1); }
.ritual-learning > header { display: flex; align-items: start; justify-content: space-between; gap: 1rem; }
.ritual-learning h3 { margin: 0; font: 500 1.75rem "Iowan Old Style", serif; }
.ritual-learning > header > span { border-radius: 999px; padding: .35rem .55rem; color: #5d4930; background: #eadbb3; font: 800 .62rem ui-monospace, monospace; text-transform: uppercase; }
.ritual-learning__rationale { color: #263429; font-weight: 650; line-height: 1.5; }
.ritual-learning blockquote { margin: .9rem 0; border-left: 3px solid #617562; padding: .2rem 0 .2rem .8rem; color: #516054; font-size: .82rem; }
.ritual-learning__comparison { display: grid; grid-template-columns: 1fr 1fr; gap: .8rem; }
.ritual-learning__comparison article { border: 1px solid #c2cabb; border-radius: .8rem; padding: .9rem; background: #fffdf2; }
.ritual-learning__comparison article:last-child { border-color: #809c78; background: #edf5e8; }
.ritual-learning__comparison h4, .ritual-learning__comparison small { margin: 0 0 .55rem; color: #617064; font: 800 .62rem ui-monospace, monospace; letter-spacing: .07em; text-transform: uppercase; }
.ritual-learning__comparison p, .ritual-learning__comparison li { color: #364238; font-size: .78rem; line-height: 1.45; }
.ritual-learning__comparison ol, .ritual-learning__comparison ul { margin: .45rem 0 .9rem; padding-left: 1.1rem; }
.ritual-learning__guardrail { border-radius: .7rem; padding: .7rem; color: #3f553f; background: #e1ead9; font-size: .75rem; line-height: 1.45; }
.ritual-learning footer button { min-height: 40px; margin: .5rem .45rem 0 0; border: 1px solid #617562; border-radius: 999px; padding: .6rem .9rem; color: #263429; background: transparent; font: 800 .76rem ui-sans-serif, system-ui; cursor: pointer; }
.ritual-learning footer button:first-child { border-color: #38523a; color: #f3f7ed; background: #38523a; }
.ritual-learning footer button:disabled { cursor: wait; opacity: .58; }
.ritual-draft__empty { display: grid; place-items: center; min-height: 68vh; color: #637067; text-align: center; }
.ritual-draft__empty span { display: grid; place-items: center; width: 4.5rem; height: 4.5rem; border: 1px solid #899488; border-radius: 50%; font: 500 2.4rem "Iowan Old Style", serif; }
.ritual-draft__empty p { max-width: 24rem; line-height: 1.6; }
button:focus-visible { outline: 3px solid white !important; outline-offset: 3px; }
button:disabled { cursor: not-allowed !important; opacity: .52; }
input:focus-visible, textarea:focus-visible { outline: 3px solid #b8e19f; outline-offset: 3px; }
@media (max-width: 860px) { .ritual-builder { display: block; height: auto; min-height: 100vh; } .ritual-conversation { min-height: 100vh; padding: 0 1.25rem 3rem; } .ritual-conversation__header { position: static; } .ritual-welcome { margin-top: 2.5rem; } .ritual-draft { max-height: none; border-top: 1px solid #445043; border-left: 0; padding: 1.5rem 1.25rem; } .ritual-start__choices, .ritual-decisions > div, .ritual-learning__comparison, .ritual-schedule { grid-template-columns: 1fr; } .ritual-schedule small { grid-column: 1; } .ritual-message { grid-template-columns: 4rem 1fr; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration: .01ms !important; animation-duration: .01ms !important; } }`;

const shieldHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <style>
      html, body { margin: 0; height: 100%; background: transparent; font-family: ui-sans-serif, system-ui; }
      body { display: grid; place-items: start center; }
      p { margin-top: 14px; padding: 7px 12px; border-radius: 999px; color: #eaf5e5; background: rgba(16, 20, 16, .88); font-size: 12px; letter-spacing: .08em; }
    </style>
  </head>
  <body><p>AGENT CONTROL · TAKE OVER FROM VILLAGE</p></body>
</html>`;

export function registerVillageScheme(
  protocolModule: typeof import("electron").protocol,
): void {
  protocolModule.registerSchemesAsPrivileged([
    {
      scheme: "village",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: false,
      },
    },
  ]);
}

export function installVillageProtocol(
  protocolModule: Protocol,
  rendererRoot: string,
): void {
  const rendererSource = readFile(join(rendererRoot, "index.js"));
  protocolModule.handle("village", async (request) => {
    const url = new URL(request.url);
    if (url.host !== "app") return new Response("Not found", { status: 404 });
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(indexHtml, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url.pathname === "/shield") {
      return new Response(shieldHtml, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url.pathname === "/styles.css") {
      return new Response(styles, {
        headers: { "content-type": "text/css; charset=utf-8" },
      });
    }
    if (url.pathname === "/renderer.js") {
      return new Response(await rendererSource, {
        headers: { "content-type": "text/javascript; charset=utf-8" },
      });
    }
    return new Response("Not found", { status: 404 });
  });
}
