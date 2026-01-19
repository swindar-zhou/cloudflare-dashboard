/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

// export default {
// 	async fetch(request, env, ctx): Promise<Response> {
// 		const url = new URL(request.url);
// 		switch (url.pathname) {
// 			case '/message':
// 				return new Response('Hello, World!');
// 			case '/random':
// 				return new Response(crypto.randomUUID());
// 			default:
// 				return new Response('Not Found', { status: 404 });
// 		}
// 	},
// } satisfies ExportedHandler<Env>;

export interface Env {
	feedback_db: D1Database;
	AI: Ai;
}

type NewFeedbackPayload = {
	source?: string; // e.g. "discord", "github", "email"
	content: string;
	type?: string; // "bug" | "idea" | "general" | "testimonial"
};

function json(data: unknown, init: ResponseInit = {}) {
	return new Response(JSON.stringify(data, null, 2), {
		...init,
		headers: {
			"content-type": "application/json; charset=utf-8",
			...(init.headers || {}),
		},
	});
}

function badRequest(message: string, details?: unknown) {
	return json({ ok: false, error: message, details }, { status: 400 });
}

async function readJson<T>(request: Request): Promise<T> {
	const contentType = request.headers.get("content-type") || "";
	if (!contentType.includes("application/json")) {
		throw new Error("Expected application/json body");
	}
	return (await request.json()) as T;
}

// Helper function to analyze feedback using Workers AI
async function analyzeFeedbackWithAI(content: string, id: number, env: Env): Promise<{ theme: string; sentiment: string; urgency: number }> {
	const prompt = `Analyze the following feedback about Cloudflare products and services. Return a JSON object with:
1. "theme": One of these Cloudflare product categories: "workers", "pages", "r2", "d1", "kv", "auth", "billing", "docs", "dashboard", "api", or "general"
2. "sentiment": One of "positive", "negative", or "neutral"
3. "urgency": A number from 1-5 where 1=low priority, 3=medium, 5=critical/urgent (use 5 for blocking issues, ASAP requests, or production outages)

Feedback text:
"${content}"

Return ONLY valid JSON in this exact format:
{"theme": "workers", "sentiment": "positive", "urgency": 2}`;

	try {
		// Call Workers AI using llama-3-8b-instruct with JSON mode
		const aiResponse = await env.AI.run("@cf/meta/llama-3-8b-instruct", {
			messages: [
				{
					role: "system",
					content: "You are a feedback analysis assistant. Always respond with valid JSON only, no additional text.",
				},
				{
					role: "user",
					content: prompt,
				},
			],
			max_tokens: 200,
			temperature: 0.3,
			response_format: {
				type: "json_object",
			},
		});

		// Parse AI response - output is AiTextGenerationOutput with response property
		const responseText = (aiResponse as { response?: string }).response || "";
		
		// Extract JSON from response (handle cases where AI adds extra text)
		let jsonText = responseText.trim();
		
		// Try to extract JSON if wrapped in markdown code blocks
		const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			jsonText = jsonMatch[0];
		}

		const analysis = JSON.parse(jsonText) as { theme: string; sentiment: string; urgency: number };

		// Validate and normalize the response
		const validThemes = ["workers", "pages", "r2", "d1", "kv", "auth", "billing", "docs", "dashboard", "api", "general"];
		const validSentiments = ["positive", "negative", "neutral"];

		const theme = validThemes.includes(analysis.theme?.toLowerCase()) 
			? analysis.theme.toLowerCase() 
			: "general";
		
		const sentiment = validSentiments.includes(analysis.sentiment?.toLowerCase())
			? analysis.sentiment.toLowerCase()
			: "neutral";

		const urgency = Math.max(1, Math.min(5, Math.round(Number(analysis.urgency) || 1)));

		// Save analysis back to database
		await env.feedback_db
			.prepare(`UPDATE feedback SET theme = ?, sentiment = ?, urgency = ? WHERE id = ?`)
			.bind(theme, sentiment, urgency, id)
			.run();

		return { theme, sentiment, urgency };
	} catch (error) {
		console.error("AI analysis error:", error);
		// Fallback to basic analysis if AI fails
		const text = content.toLowerCase();
		const sentiment =
			text.includes("love") || text.includes("great") || text.includes("amazing") || text.includes("fantastic")
				? "positive"
				: text.includes("hate") || text.includes("broken") || text.includes("bug") || text.includes("terrible") || text.includes("failing")
					? "negative"
					: "neutral";

		const theme =
			text.includes("worker") || text.includes("workers")
				? "workers"
				: text.includes("pages") || text.includes("cloudflare pages")
					? "pages"
					: text.includes("r2") || text.includes("object storage") || text.includes("s3")
						? "r2"
						: text.includes("d1") || text.includes("database") || text.includes("sqlite")
							? "d1"
							: text.includes("kv") || text.includes("key-value")
								? "kv"
								: text.includes("auth") || text.includes("login") || text.includes("authentication")
									? "auth"
									: text.includes("billing") || text.includes("price") || text.includes("payment") || text.includes("cost")
										? "billing"
										: text.includes("docs") || text.includes("documentation") || text.includes("tutorial")
											? "docs"
											: text.includes("ui") || text.includes("dashboard") || text.includes("interface")
												? "dashboard"
												: text.includes("api") || text.includes("endpoint")
													? "api"
													: "general";

		const urgency =
			text.includes("blocked") || text.includes("urgent") || text.includes("asap") || text.includes("down") || text.includes("broken")
				? 5
				: text.includes("annoying") || text.includes("slow") || text.includes("confusing")
					? 3
					: 1;

		await env.feedback_db
			.prepare(`UPDATE feedback SET theme = ?, sentiment = ?, urgency = ? WHERE id = ?`)
			.bind(theme, sentiment, urgency, id)
			.run();

		return { theme, sentiment, urgency };
	}
}

// --- Endpoint 1: POST /api/feedback
async function handleCreateFeedback(request: Request, env: Env) {
	let body: NewFeedbackPayload;
	try {
		body = await readJson<NewFeedbackPayload>(request);
	} catch (e) {
		return badRequest("Invalid JSON body or missing content-type: application/json", String(e));
	}

	const content = (body.content || "").trim();
	if (!content) return badRequest("Field `content` is required.");

	const source = (body.source || "manual").trim();
	const type = body.type?.trim() || null;
	const createdAt = new Date().toISOString();

	const stmt = env.feedback_db
		.prepare(
			`INSERT INTO feedback (source, content, created_at, type, theme, sentiment, urgency)
       VALUES (?, ?, ?, ?, NULL, NULL, 0)`
		)
		.bind(source, content, createdAt, type);

	const result = await stmt.run();
	// D1 returns meta info; we'll fetch the inserted row id if possible
	const insertedId = (result.meta as any)?.last_row_id ?? null;

	// Auto-analyze the feedback (wait for it to complete)
	if (insertedId) {
		try {
			await analyzeFeedbackWithAI(content, insertedId, env);
		} catch (err) {
			console.error("Auto-analysis failed for feedback", insertedId, err);
		}
	}

	return json({
		ok: true,
		id: insertedId,
		source,
		type,
		created_at: createdAt,
	});
}

// --- Endpoint 2: GET /api/feedback
async function handleListFeedback(request: Request, env: Env) {
	const url = new URL(request.url);
	const limit = Math.min(Number(url.searchParams.get("limit") || "50"), 200);

	const themeFilter = url.searchParams.get("theme");

	let stmt;
	if (themeFilter) {
		stmt = env.feedback_db.prepare(
			`SELECT id, source, content, created_at, type, theme, sentiment, urgency
       FROM feedback
       WHERE theme = ?
       ORDER BY urgency DESC, id DESC
       LIMIT ?`
		);
		stmt = stmt.bind(themeFilter, limit);
	} else {
		stmt = env.feedback_db.prepare(
			`SELECT id, source, content, created_at, type, theme, sentiment, urgency
       FROM feedback
       ORDER BY urgency DESC, id DESC
       LIMIT ?`
		);
		stmt = stmt.bind(limit);
	}

	const { results } = await stmt.all();

	return json({ ok: true, count: results.length, items: results });
}

// --- Endpoint 3: GET /api/summary
async function handleGetSummary(request: Request, env: Env) {
	// Get total count
	const totalResult = await env.feedback_db
		.prepare(`SELECT COUNT(*) as total FROM feedback`)
		.first<{ total: number }>();

	// Get sentiment breakdown
	const sentimentStmt = env.feedback_db.prepare(
		`SELECT sentiment, COUNT(*) as count 
     FROM feedback 
     WHERE sentiment IS NOT NULL 
     GROUP BY sentiment`
	);
	const sentimentResults = await sentimentStmt.all();

	// Get theme breakdown with urgent counts
	const themeStmt = env.feedback_db.prepare(
		`SELECT theme, COUNT(*) as count,
       SUM(CASE WHEN urgency >= 4 THEN 1 ELSE 0 END) as urgent_count
     FROM feedback 
     WHERE theme IS NOT NULL 
     GROUP BY theme`
	);
	const themeResults = await themeStmt.all();

	// Get type breakdown with urgent and negative percentages
	const typeStmt = env.feedback_db.prepare(
		`SELECT type, COUNT(*) as count,
       SUM(CASE WHEN urgency >= 4 THEN 1 ELSE 0 END) as urgent_count,
       SUM(CASE WHEN sentiment = 'negative' THEN 1 ELSE 0 END) as negative_count
     FROM feedback 
     WHERE type IS NOT NULL 
     GROUP BY type`
	);
	const typeResults = await typeStmt.all();

	// Get urgent count (urgency >= 4)
	const urgentResult = await env.feedback_db
		.prepare(`SELECT COUNT(*) as count FROM feedback WHERE urgency >= 4`)
		.first<{ count: number }>();

	const sentimentBreakdown: Record<string, number> = {};
	for (const row of sentimentResults.results as any[]) {
		sentimentBreakdown[row.sentiment] = row.count;
	}

	const themeBreakdown: Array<{ theme: string; count: number; urgent_count: number }> = [];
	for (const row of themeResults.results as any[]) {
		themeBreakdown.push({
			theme: row.theme,
			count: row.count,
			urgent_count: row.urgent_count || 0,
		});
	}
	// Sort by count descending
	themeBreakdown.sort((a, b) => b.count - a.count);

	const typeBreakdown: Array<{ type: string; count: number; urgent_count: number; negative_count: number }> = [];
	for (const row of typeResults.results as any[]) {
		typeBreakdown.push({
			type: row.type,
			count: row.count,
			urgent_count: row.urgent_count || 0,
			negative_count: row.negative_count || 0,
		});
	}

	return json({
		ok: true,
		total: totalResult?.total || 0,
		sentiment: sentimentBreakdown,
		theme: themeBreakdown,
		type: typeBreakdown,
		urgent: urgentResult?.count || 0,
	});
}

// --- Endpoint 4: POST /api/analyze (kept for backward compatibility, but auto-analysis is now default)
async function handleAnalyzeFeedback(request: Request, env: Env) {
	type AnalyzePayload = { id: number };

	let body: AnalyzePayload;
	try {
		body = await readJson<AnalyzePayload>(request);
	} catch (e) {
		return badRequest("Invalid JSON body or missing content-type: application/json", String(e));
	}

	const id = Number(body.id);
	if (!Number.isFinite(id)) return badRequest("Field `id` must be a number.");

	// Load feedback text
	const row = await env.feedback_db
		.prepare(`SELECT id, content FROM feedback WHERE id = ?`)
		.bind(id)
		.first<{ id: number; content: string }>();

	if (!row) return json({ ok: false, error: "Feedback not found" }, { status: 404 });

	const analysis = await analyzeFeedbackWithAI(row.content, id, env);

	return json({
		ok: true,
		id,
		analysis,
	});
}

// --- Endpoint 5: GET /api/feedback/:id/suggestions
// Get AI suggestions for what to do next with this feedback
async function handleGetSuggestions(request: Request, env: Env) {
	const url = new URL(request.url);
	const pathParts = url.pathname.split("/");
	const id = Number(pathParts[pathParts.length - 2]); // /api/feedback/:id/suggestions

	if (!Number.isFinite(id)) return badRequest("Invalid feedback ID");

	// Load feedback with analysis
	const row = await env.feedback_db
		.prepare(`SELECT id, content, type, theme, sentiment, urgency, source, created_at FROM feedback WHERE id = ?`)
		.bind(id)
		.first<{ id: number; content: string; type: string | null; theme: string | null; sentiment: string | null; urgency: number; source: string; created_at: string }>();

	if (!row) return json({ ok: false, error: "Feedback not found" }, { status: 404 });

	const prompt = `You are a product manager assistant for Cloudflare. Based on the following feedback, provide actionable suggestions on what to do next.

Feedback Details:
- Content: "${row.content}"
- Type: ${row.type || "unknown"}
- Theme: ${row.theme || "unknown"}
- Sentiment: ${row.sentiment || "unknown"}
- Urgency: ${row.urgency}/5
- Source: ${row.source}

Provide 3-5 specific, actionable suggestions as a JSON array of objects. Each suggestion object must have:
- "action": A short action verb phrase (e.g., "Escalate to support", "Add to roadmap", "Fix bug", "Update documentation")
- "description": A detailed description of what to do (max 60 words)
- "category": One of "immediate", "product", "bug", "documentation", "communication", "follow-up"
- "priority": "high", "medium", or "low"
- "theme": The relevant Cloudflare product theme (e.g., "workers", "r2", "d1", "general")
- "reasoning": A brief explanation of why this suggestion was made (max 30 words, e.g., "Detected: R2 upload issues + delayed support response")
- "confidence": A confidence score between 0.0 and 1.0 (e.g., 0.82)

Return ONLY valid JSON in this exact format:
{
  "suggestions": [
    {
      "action": "Escalate to support",
      "description": "Immediately escalate the ticket to a senior support engineer to ensure a timely response.",
      "category": "immediate",
      "priority": "high",
      "theme": "r2",
      "reasoning": "Detected: R2 upload issues + delayed support response",
      "confidence": 0.85
    },
    {
      "action": "Review support process",
      "description": "Review and optimize our support response times to ensure customers receive timely assistance.",
      "category": "product",
      "priority": "medium",
      "theme": "general",
      "reasoning": "Detected: Support response time concerns",
      "confidence": 0.78
    }
  ]
}`;

	try {
		const aiResponse = await env.AI.run("@cf/meta/llama-3-8b-instruct", {
			messages: [
				{
					role: "system",
					content: "You are a product manager assistant. Always respond with valid JSON only, no additional text.",
				},
				{
					role: "user",
					content: prompt,
				},
			],
			max_tokens: 300,
			temperature: 0.5,
			response_format: {
				type: "json_object",
			},
		});

		const responseText = (aiResponse as { response?: string }).response || "";
		let jsonText = responseText.trim();
		
		// Extract JSON object
		const objMatch = jsonText.match(/\{[\s\S]*\}/);
		if (objMatch) {
			jsonText = objMatch[0];
		}

		const parsed = JSON.parse(jsonText) as { 
			suggestions?: Array<{ 
				action: string; 
				description: string; 
				category: string; 
				priority: string; 
				theme: string;
				reasoning?: string;
				confidence?: number;
			}> 
		};
		const suggestions = parsed.suggestions || [];

		// Validate and normalize suggestions
		const validSuggestions = suggestions
			.filter(s => s && s.action && s.description)
			.map(s => ({
				action: s.action || "Action needed",
				description: s.description || "",
				category: s.category || "follow-up",
				priority: s.priority || "medium",
				theme: s.theme || "general",
				reasoning: s.reasoning || "Based on feedback analysis",
				confidence: Math.max(0, Math.min(1, Number(s.confidence) || 0.75)),
			}))
			.slice(0, 5);

		return json({
			ok: true,
			id,
			suggestions: validSuggestions,
		});
	} catch (error) {
		console.error("AI suggestions error:", error);
		// Fallback suggestions
		const fallbackSuggestions: Array<{ action: string; description: string; category: string; priority: string; theme: string; reasoning: string; confidence: number }> = [];
		
		if (row.urgency >= 4) {
			fallbackSuggestions.push({
				action: "Prioritize immediately",
				description: "High urgency: Prioritize this feedback and assign to the appropriate team immediately.",
				category: "immediate",
				priority: "high",
				theme: row.theme || "general",
				reasoning: `Detected: High urgency (${row.urgency}/5) + ${row.theme || "general"} theme`,
				confidence: 0.9,
			});
		}
		if (row.type === "bug") {
			fallbackSuggestions.push({
				action: "Create bug ticket",
				description: "Bug report: Create a ticket in the bug tracking system and assign to engineering.",
				category: "bug",
				priority: row.urgency >= 4 ? "high" : "medium",
				theme: row.theme || "general",
				reasoning: `Detected: Bug report for ${row.theme || "general"} product`,
				confidence: 0.85,
			});
		}
		if (row.type === "idea") {
			fallbackSuggestions.push({
				action: "Add to roadmap",
				description: "Feature idea: Add to product roadmap for consideration in next planning cycle.",
				category: "product",
				priority: "medium",
				theme: row.theme || "general",
				reasoning: `Detected: Feature idea for ${row.theme || "general"} product`,
				confidence: 0.8,
			});
		}
		if (row.sentiment === "negative") {
			fallbackSuggestions.push({
				action: "Reach out to user",
				description: "Negative sentiment: Consider reaching out to the user to understand their concerns better.",
				category: "communication",
				priority: "medium",
				theme: row.theme || "general",
				reasoning: "Detected: Negative sentiment requiring user outreach",
				confidence: 0.75,
			});
		}
		fallbackSuggestions.push({
			action: "Review with team",
			description: "Review the feedback with the product team and determine next steps.",
			category: "follow-up",
			priority: "low",
			theme: row.theme || "general",
			reasoning: "Standard follow-up action",
			confidence: 0.7,
		});

		return json({
			ok: true,
			id,
			suggestions: fallbackSuggestions.slice(0, 5),
		});
	}
}

// --- Endpoint 5: POST /api/seed
// Populate database with realistic Cloudflare product feedback
async function handleSeedDatabase(request: Request, env: Env) {
	const seedData = [
		// Workers feedback
		{
			content: "Workers are amazing! The edge computing capabilities have reduced our API latency by 60%. Love the developer experience.",
			type: "testimonial",
			source: "github",
		},
		{
			content: "Workers timeout limits are too restrictive for our data processing pipeline. We need longer execution times for batch jobs.",
			type: "idea",
			source: "discord",
		},
		{
			content: "Worker deployed but returning 500 errors in production. Stack traces are not showing up in dashboard. This is blocking our release.",
			type: "bug",
			source: "email",
		},
		{
			content: "The Workers editor in dashboard is great, but we need better debugging tools. Can we get step-through debugging?",
			type: "idea",
			source: "github",
		},
		{
			content: "Workers AI integration is fantastic! We're using it for image processing and it's incredibly fast at the edge.",
			type: "testimonial",
			source: "discord",
		},
		// Pages feedback
		{
			content: "Cloudflare Pages deployment is broken after the last update. Builds are failing with 'deployment timeout' errors. ASAP please!",
			type: "bug",
			source: "email",
		},
		{
			content: "Pages preview deployments are a game changer for our team. The instant preview URLs save us so much time.",
			type: "testimonial",
			source: "github",
		},
		{
			content: "Would love to see support for monorepos in Pages. Currently we have to deploy each app separately which is annoying.",
			type: "idea",
			source: "discord",
		},
		{
			content: "Pages build logs are confusing. Error messages don't point to the actual file causing issues. Need better error reporting.",
			type: "general",
			source: "github",
		},
		// R2 feedback
		{
			content: "R2 storage costs are way better than S3. We've cut our storage bill in half. Amazing product!",
			type: "testimonial",
			source: "email",
		},
		{
			content: "R2 multipart upload is failing for large files (>5GB). Getting 'connection reset' errors randomly. This is urgent.",
			type: "bug",
			source: "github",
		},
		{
			content: "Need lifecycle policies for R2 similar to S3. We want to automatically delete old backups after 30 days.",
			type: "idea",
			source: "discord",
		},
		{
			content: "R2 dashboard is slow when listing buckets with thousands of objects. Pagination would help a lot.",
			type: "idea",
			source: "github",
		},
		// D1 feedback
		{
			content: "D1 database is perfect for our use case. The SQLite compatibility made migration from our existing setup seamless.",
			type: "testimonial",
			source: "discord",
		},
		{
			content: "D1 queries are timing out on large tables. We have 100k+ rows and SELECT queries take 30+ seconds. Performance needs improvement.",
			type: "bug",
			source: "email",
		},
		{
			content: "Would love to see D1 support for transactions across multiple statements. Currently we have to use workarounds.",
			type: "idea",
			source: "github",
		},
		{
			content: "D1 backup and restore feature is missing. We need a way to export our database for local development.",
			type: "idea",
			source: "discord",
		},
		// Auth feedback
		{
			content: "Cloudflare Access login is broken after the last update. Users can't authenticate. This is blocking all our users!",
			type: "bug",
			source: "email",
		},
		{
			content: "Access integration with Workers is great. The seamless auth flow improved our app security significantly.",
			type: "testimonial",
			source: "github",
		},
		{
			content: "Need support for OAuth providers beyond Google and GitHub. We use Okta for SSO and it's not supported yet.",
			type: "idea",
			source: "discord",
		},
		// Billing feedback
		{
			content: "Billing dashboard doesn't show itemized costs for Workers requests. Hard to understand what we're paying for.",
			type: "general",
			source: "email",
		},
		{
			content: "The pay-as-you-go pricing is perfect for our startup. No upfront costs and we only pay for what we use.",
			type: "testimonial",
			source: "github",
		},
		// API feedback
		{
			content: "Cloudflare API rate limits are too strict. We're building a monitoring tool and hitting limits constantly.",
			type: "idea",
			source: "discord",
		},
		{
			content: "API documentation is excellent. The examples in the docs helped us integrate Workers AI in minutes.",
			type: "testimonial",
			source: "github",
		},
		// Docs feedback
		{
			content: "Documentation for D1 migrations is confusing. The examples don't match the actual API. Need clearer guides.",
			type: "general",
			source: "email",
		},
		{
			content: "The Workers tutorials are amazing! Learned edge computing concepts I didn't understand before.",
			type: "testimonial",
			source: "github",
		},
		// Dashboard feedback
		{
			content: "Dashboard analytics for Workers are limited. We need more detailed metrics on request patterns and errors.",
			type: "idea",
			source: "discord",
		},
		{
			content: "The new dashboard design is clean and fast. Much better than the old interface!",
			type: "testimonial",
			source: "email",
		},
		// General feedback
		{
			content: "Overall, Cloudflare's developer experience is top-notch. The platform just works and scales beautifully.",
			type: "testimonial",
			source: "github",
		},
		{
			content: "Support response times are slow. We submitted a ticket 3 days ago about R2 upload issues and still no response.",
			type: "general",
			source: "email",
		},
		// LinkedIn feedback
		{
			content: "Just shared our Cloudflare Workers success story on LinkedIn! Reduced our API costs by 40% while improving performance. Highly recommend!",
			type: "testimonial",
			source: "linkedin",
		},
		{
			content: "Looking for advice: Has anyone migrated from AWS S3 to Cloudflare R2? We're considering it for cost savings but worried about migration complexity.",
			type: "idea",
			source: "linkedin",
		},
		{
			content: "Cloudflare Pages integration with GitHub is seamless. Our team loves the automatic deployments and preview URLs.",
			type: "testimonial",
			source: "linkedin",
		},
		// Cloudflare platform feedback
		{
			content: "The Cloudflare dashboard needs better analytics. We can't see detailed bandwidth usage per service. This is critical for our billing.",
			type: "idea",
			source: "cloudflare",
		},
		{
			content: "Cloudflare Workers AI is revolutionary! We're using it for real-time image processing and it's incredibly fast.",
			type: "testimonial",
			source: "cloudflare",
		},
		{
			content: "D1 database connection pooling would be a game changer. Right now we're hitting connection limits during peak traffic.",
			type: "idea",
			source: "cloudflare",
		},
	];

	// Clear existing data (optional - comment out if you want to keep existing)
	await env.feedback_db.prepare(`DELETE FROM feedback`).run();

	// Insert seed data
	const stmt = env.feedback_db.prepare(
		`INSERT INTO feedback (source, content, created_at, type, theme, sentiment, urgency)
     VALUES (?, ?, ?, ?, NULL, NULL, 0)`
	);

	const now = Date.now();
	const insertedIds: number[] = [];

	for (let i = 0; i < seedData.length; i++) {
		const item = seedData[i];
		// Spread out creation times over the past 2 weeks
		const daysAgo = Math.floor(i / 2);
		const hoursAgo = i % 24;
		const createdAt = new Date(now - daysAgo * 24 * 60 * 60 * 1000 - hoursAgo * 60 * 60 * 1000).toISOString();

		const result = await stmt.bind(item.source, item.content, createdAt, item.type).run();
		const id = (result.meta as any)?.last_row_id;
		if (id) {
			insertedIds.push(id);
			// Auto-analyze each feedback item (wait for completion)
			try {
				await analyzeFeedbackWithAI(item.content, id, env);
			} catch (err) {
				console.error("Auto-analysis failed for feedback", id, err);
			}
		}
	}

	return json({
		ok: true,
		message: `Seeded ${insertedIds.length} feedback items. All items have been analyzed.`,
		ids: insertedIds,
	});
}

// --- Endpoint 6: POST /api/analyze-all
// Analyze all unanalyzed feedback items
async function handleAnalyzeAll(request: Request, env: Env) {
	// Get all unanalyzed feedback (where theme is NULL)
	const unanalyzed = await env.feedback_db
		.prepare(`SELECT id, content FROM feedback WHERE theme IS NULL OR sentiment IS NULL`)
		.all<{ id: number; content: string }>();

	const results = {
		total: unanalyzed.results.length,
		analyzed: 0,
		failed: 0,
		errors: [] as string[],
	};

	for (const item of unanalyzed.results) {
		try {
			await analyzeFeedbackWithAI(item.content, item.id, env);
			results.analyzed++;
		} catch (err) {
			results.failed++;
			results.errors.push(`Failed to analyze feedback #${item.id}: ${String(err)}`);
		}
	}

	return json({
		ok: true,
		message: `Analyzed ${results.analyzed} out of ${results.total} unanalyzed feedback items.`,
		...results,
	});
}

// --- Scheduled Worker: Daily Digest Generator
// Runs daily at 9 AM UTC (cron: "0 9 * * *")
async function generateDailyDigest(env: Env) {
	const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

	// Get top 3 themes
	const themeStmt = env.feedback_db.prepare(
		`SELECT theme, COUNT(*) as count 
     FROM feedback 
     WHERE theme IS NOT NULL 
     GROUP BY theme 
     ORDER BY count DESC 
     LIMIT 3`
	);
	const themeResults = await themeStmt.all();
	const topThemes = themeResults.results.map((row: any) => ({
		theme: row.theme,
		count: row.count,
	}));

	// Get top 5 urgent items (urgency >= 4)
	const urgentStmt = env.feedback_db.prepare(
		`SELECT id, content, theme, urgency 
     FROM feedback 
     WHERE urgency >= 4 
     ORDER BY urgency DESC, id DESC 
     LIMIT 5`
	);
	const urgentResults = await urgentStmt.all();
	const urgentItems = urgentResults.results.map((row: any) => ({
		id: row.id,
		content: row.content.substring(0, 100) + (row.content.length > 100 ? '...' : ''),
		theme: row.theme,
		urgency: row.urgency,
	}));

	// Get total feedback count
	const totalResult = await env.feedback_db
		.prepare(`SELECT COUNT(*) as total FROM feedback`)
		.first<{ total: number }>();

	// Insert or update daily digest
	const digestData = {
		date: today,
		top_themes: JSON.stringify(topThemes),
		urgent_items: JSON.stringify(urgentItems),
		total_feedback: totalResult?.total || 0,
		created_at: new Date().toISOString(),
	};

	// Check if digest already exists for today
	const existing = await env.feedback_db
		.prepare(`SELECT id FROM daily_digest WHERE date = ?`)
		.bind(digestData.date)
		.first<{ id: number }>();

	if (existing) {
		// Update existing digest
		await env.feedback_db
			.prepare(
				`UPDATE daily_digest 
         SET top_themes = ?, urgent_items = ?, total_feedback = ?, created_at = ?
         WHERE date = ?`
			)
			.bind(
				digestData.top_themes,
				digestData.urgent_items,
				digestData.total_feedback,
				digestData.created_at,
				digestData.date
			)
			.run();
	} else {
		// Insert new digest
		await env.feedback_db
			.prepare(
				`INSERT INTO daily_digest (date, top_themes, urgent_items, total_feedback, created_at)
         VALUES (?, ?, ?, ?, ?)`
			)
			.bind(
				digestData.date,
				digestData.top_themes,
				digestData.urgent_items,
				digestData.total_feedback,
				digestData.created_at
			)
			.run();
	}

	console.log(`Daily digest generated for ${today}:`, {
		topThemes: topThemes.length,
		urgentItems: urgentItems.length,
		total: digestData.total_feedback,
	});
}

// --- Endpoint 7: GET /api/integrations
// Get integrations status and feedback counts per source
async function handleGetIntegrations(request: Request, env: Env) {
	// Get feedback counts by source
	const sourceStmt = env.feedback_db.prepare(
		`SELECT source, COUNT(*) as count 
     FROM feedback 
     GROUP BY source 
     ORDER BY count DESC`
	);
	const sourceResults = await sourceStmt.all();

	const integrations = [
		{
			name: "Email",
			type: "email",
			status: "connected",
			icon: "📧",
			logo: "https://ssl.gstatic.com/ui/v1/icons/mail/rfr/gmail.ico",
			count: 0,
		},
		{
			name: "GitHub Issues",
			type: "github",
			status: "connected",
			icon: "🐙",
			logo: "https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png",
			count: 0,
		},
		{
			name: "Discord",
			type: "discord",
			status: "connected",
			icon: "💬",
			logo: "https://discord.com/assets/f9bb9c4af2b9c32a2c5ee0014661546d.png",
			count: 0,
		},
		{
			name: "Cloudflare",
			type: "cloudflare",
			status: "connected",
			icon: "☁️",
			logo: "https://www.cloudflare.com/favicon.ico",
			count: 0,
		},
		{
			name: "LinkedIn",
			type: "linkedin",
			status: "connected",
			icon: "💼",
			logo: "https://static.licdn.com/sc/h/al2o9zrvru7aqj8e1x2rzsrca",
			count: 0,
		},
	];

	// Update counts from database
	for (const row of sourceResults.results as any[]) {
		const integration = integrations.find((i) => i.type === row.source);
		if (integration) {
			integration.count = row.count;
		}
	}

	return json({
		ok: true,
		integrations,
		total: integrations.reduce((sum, i) => sum + i.count, 0),
	});
}

// --- Endpoint 8: GET /api/integrations/:source/feedback
// Get feedback items from a specific source
async function handleGetIntegrationFeedback(request: Request, env: Env) {
	const url = new URL(request.url);
	const pathParts = url.pathname.split('/');
	const source = pathParts[pathParts.length - 2]; // Get source from /api/integrations/{source}/feedback

	if (!source) {
		return json({ ok: false, error: "Source parameter required" }, { status: 400 });
	}

	const feedback = await env.feedback_db
		.prepare(
			`SELECT id, source, content, created_at, type, theme, sentiment, urgency 
       FROM feedback 
       WHERE source = ? 
       ORDER BY created_at DESC 
       LIMIT 100`
		)
		.bind(source)
		.all<{
			id: number;
			source: string;
			content: string;
			created_at: string;
			type: string | null;
			theme: string | null;
			sentiment: string | null;
			urgency: number;
		}>();

	return json({
		ok: true,
		source,
		items: feedback.results,
		count: feedback.results.length,
	});
}

// --- Endpoint 8: GET /api/digest
// Get latest daily digest
async function handleGetDigest(request: Request, env: Env) {
	const digest = await env.feedback_db
		.prepare(`SELECT * FROM daily_digest ORDER BY date DESC LIMIT 1`)
		.first<{
			id: number;
			date: string;
			top_themes: string;
			urgent_items: string;
			total_feedback: number;
			created_at: string;
		}>();

	if (!digest) {
		return json({
			ok: false,
			message: "No digest available yet. First digest will be generated tomorrow at 9 AM UTC.",
		});
	}

	return json({
		ok: true,
		digest: {
			date: digest.date,
			top_themes: JSON.parse(digest.top_themes),
			urgent_items: JSON.parse(digest.urgent_items),
			total_feedback: digest.total_feedback,
			created_at: digest.created_at,
		},
	});
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		// Basic CORS (so your UI can call your API)
		if (request.method === "OPTIONS") {
			return new Response(null, {
				status: 204,
				headers: {
					"access-control-allow-origin": "*",
					"access-control-allow-methods": "GET,POST,OPTIONS",
					"access-control-allow-headers": "content-type",
				},
			});
		}

		try {
			// --- API routes
			if (url.pathname === "/api/feedback" && request.method === "POST") {
				return withCors(await handleCreateFeedback(request, env as Env));
			}
			if (url.pathname === "/api/feedback" && request.method === "GET") {
				return withCors(await handleListFeedback(request, env as Env));
			}
			if (url.pathname === "/api/summary" && request.method === "GET") {
				return withCors(await handleGetSummary(request, env as Env));
			}
			if (url.pathname === "/api/analyze" && request.method === "POST") {
				return withCors(await handleAnalyzeFeedback(request, env as Env));
			}
			if (url.pathname.startsWith("/api/feedback/") && url.pathname.endsWith("/suggestions") && request.method === "GET") {
				return withCors(await handleGetSuggestions(request, env as Env));
			}
			if (url.pathname === "/api/analyze-all" && request.method === "POST") {
				return withCors(await handleAnalyzeAll(request, env as Env));
			}
			if (url.pathname === "/api/integrations" && request.method === "GET") {
				return withCors(await handleGetIntegrations(request, env as Env));
			}
			if (url.pathname === "/api/digest" && request.method === "GET") {
				return withCors(await handleGetDigest(request, env as Env));
			}
			if (url.pathname.startsWith("/api/integrations/") && url.pathname.endsWith("/feedback") && request.method === "GET") {
				return withCors(await handleGetIntegrationFeedback(request, env as Env));
			}
			if (url.pathname === "/api/seed" && request.method === "POST") {
				return withCors(await handleSeedDatabase(request, env as Env));
			}

			// Keep your old demo routes if you want
			if (url.pathname === "/message") return new Response("Hello, World!");
			if (url.pathname === "/random") return new Response(crypto.randomUUID());

			return new Response("Not Found", { status: 404 });
		} catch (err) {
			return withCors(
				json({ ok: false, error: "Internal error", details: String(err) }, { status: 500 })
			);
		}
	},
	async scheduled(controller, env, ctx): Promise<void> {
		// Generate daily digest
		await generateDailyDigest(env as Env);
	},
} satisfies ExportedHandler<Env>;

function withCors(res: Response) {
	const headers = new Headers(res.headers);
	headers.set("access-control-allow-origin", "*");
	return new Response(res.body, { ...res, headers });
}
