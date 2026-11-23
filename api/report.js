// GET /api/report: the weekly bots report as an HTML page, built from the bots' saved state
// on each request (so it's always current). Behind the dashboard login like everything else.
import { loadBots } from "../lib/trader/bots.js";
import { reportHtml, reportMarkdown, summarizeBot } from "../lib/trader/report.js";

export default async function handler(req, res) {
  const now = Date.now();
  const html = reportHtml(reportMarkdown(loadBots().map((b) => summarizeBot(b, now)), now));
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(html);
}
