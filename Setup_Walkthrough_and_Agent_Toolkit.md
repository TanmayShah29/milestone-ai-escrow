# PayPal AI Hackathon: Setup Walkthrough Notes and Agent Toolkit

Added: Oct 15, 2026

## Source and reliability
The webinar notes below come from a summary you supplied of the Oct 6 session, "Set Up PayPal's Sandbox and AI Toolkit From Scratch (Live Walkthrough)". The video link was https://youtu.be/FFJfCW9z3Do (I could not open it myself, so I haven't checked the notes against the video).
The summary had no timestamps and several of its links were Google-search wrappers rather than direct URLs. I checked what I could against PayPal's own docs. Each item is marked below as VERIFIED or NOT VERIFIED.

## Session overview (from the summary)
- Hosted by Darlyze Calixte (Devpost) with PayPal's Jo Franchetti, Marco Podien and Eddie Jaoude
- Goal: build AI-powered agentic experiences integrated with payments using PayPal's developer ecosystem
- Judging focus: real-world application, working Sandbox/API implementations, innovation, clean developer workflows (matches the Devpost judging criteria)

## 1. PayPal Sandbox setup
Purpose: test API integrations, transaction flows, webhooks and UI components with test credentials, no real money.
1. Go to the PayPal Developer Portal: https://developer.paypal.com/ (VERIFIED, it is the link on the hackathon page)
2. Log in with your developer account and open the Sandbox dashboard
3. Create sandbox **Business** (seller) and **Personal** (buyer) accounts
4. In your REST API app, copy the **Client ID** and **Secret** to authenticate your backend/frontend

## 2. PayPal Agent Toolkit (the summary calls it the "AI Toolkit")
The official name is **PayPal Agent Toolkit** plus the **PayPal MCP server** (VERIFIED against PayPal's docs).
- Official docs: https://developer.paypal.com/ai-tools/mcp-server
- Repo: https://github.com/paypal/agent-toolkit (the summary only gave github.com/paypal, which is the general org page)
- Works with: OpenAI Agents SDK, Vercel AI SDK, LangChain, CrewAI and MCP clients (Claude Desktop, Cursor, Cline, GitHub Copilot)
- Covers: orders, invoices, subscriptions, shipment tracking, transaction details, disputes
- Local MCP server: needs Node.js 18+; run `npx -y @paypal/mcp --tools=all` with the env vars `PAYPAL_ACCESS_TOKEN` and `PAYPAL_ENVIRONMENT=SANDBOX`
- Remote hosted MCP server also exists (SSE and streamable transports, authenticates with your PayPal client credentials)
- Token generation steps are in the repo's modelcontextprotocol folder

## 3. End-to-end payment test flow (from the summary)
1. **Create an order:** POST to `https://api-m.sandbox.paypal.com/v2/checkout/orders` with amount, currency and items. This is the standard Orders v2 sandbox endpoint (from my own knowledge; I didn't re-check it this session).
2. **Approve:** open the approval link and log in with your Sandbox Personal (buyer) account to simulate checkout
3. **Capture:** call the capture API and make sure your webhook/backend handles the settlement state
4. Tip from the summary: test these calls in Postman before writing code (auth, create order, capture, refund)

## Links from the summary
- https://developer.paypal.com/ - VERIFIED
- https://github.com/paypal - exists as PayPal's GitHub org; use github.com/paypal/agent-toolkit for the toolkit
- PayPal Postman collection (postman.com/paypal) - NOT VERIFIED (came as a Google-search wrapper)
- Sandbox site (sandbox.paypal.com) - NOT VERIFIED (same reason)
- PayPal Developer Discord (developer.paypal.com/discord) - NOT VERIFIED (same reason). Check the hackathon's Discussions tab and the Devpost Resources tab for the official community link.

## Extra sponsor tool descriptions (from PayPal's blog post)
- Kernel: cloud infrastructure so AI agents can browse and act on the internet
- Astropods: agent-native infrastructure to build, deploy and run AI agents
- Elastic: fast hybrid and vector search built for AI
- AG Grid: AG Studio, for self-serve dashboards, drag-and-drop charts and an AI assistant built into your app
- APIMatic: Context Plugin that gives your AI agent instant PayPal API context
- Render: Render Workflows for deploying and orchestrating AI agents at scale
