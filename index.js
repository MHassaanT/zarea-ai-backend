// ai-processor/index.js
// OpenRouter API with smart cost strategy:
//
//   classify  --> FREE model  (binary classification, any model gets this right)
//   qualify   --> NO API CALL (pure JS logic — just counting messages, zero cost)
//   extract   --> FREE model  (name/email extraction, no creativity needed)
//   reply     --> PAID model  (customer-facing, this is your product, quality matters)
//
// Result: credits spent on reply only — the one call your customer actually sees.

require('dotenv').config();
const admin = require('firebase-admin');

// --- Global Variables ---
const RAW_MESSAGES_COLLECTION  = 'raw_messages';
const LEADS_COLLECTION         = 'leads';
const QUALIFIED_LEADS_COLLECTION = 'qualified_leads';

// --- OpenRouter API Configuration ---
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

// FREE model  -- background tasks (classify, extract). Zero credit cost.
// PAID model  -- customer-facing replies only. Best quality-per-dollar on OpenRouter.
//               DeepSeek Chat: $0.27 input / $1.10 output per 1M tokens.

const MODEL_REPLY = "deepseek/deepseek-chat";
const MODEL_FREE  = MODEL_REPLY;
let db;

// --- OpenRouter Request Wrapper (with retry on 429) ---
async function openRouterRequest(systemPrompt, userMessage, model, jsonMode = false, maxRetries = 5) {
    if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set.");

    const body = {
        model,
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user",   content: userMessage   }
        ],
        max_tokens: jsonMode ? 300 : 1000,
        ...(jsonMode && { response_format: { type: "json_object" } })
    };

    let delay = 5000;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const response = await fetch(OPENROUTER_API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
                "HTTP-Referer": "https://zarea.site",
                "X-Title": "ZareaAI"
            },
            body: JSON.stringify(body)
        });

        if (response.status === 429) {
            console.warn(`Retrying in ${delay / 1000}s (attempt ${attempt}/${maxRetries})...`);
            await new Promise(res => setTimeout(res, delay));
            delay *= 2;
            continue;
        }

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`OpenRouter error ${response.status}: ${errText}`);
        }

        const result = await response.json();
        const text = result.choices?.[0]?.message?.content?.trim();
        if (!text) throw new Error("OpenRouter returned empty content.");
        return text;
    }
    throw new Error("OpenRouter: Max retries exceeded.");
}

// --- Firebase Initialization ---
function initializeFirebase() {
    try {
        const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_API_BASE64;
        if (!serviceAccountBase64) {
            console.error("FIREBASE_SERVICE_ACCOUNT_API_BASE64 not set.");
            process.exit(1);
        }
        const serviceAccount = JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('utf8'));
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        db = admin.firestore();
        console.log("Firebase Admin Initialized");
    } catch (error) {
        console.error("Firebase init error:", error.message);
        process.exit(1);
    }
}

// --- Business Context ---
async function getBusinessContext(userId) {
    try {
        const contextDoc = await db.collection('business_context').doc(userId).get();
        if (contextDoc.exists) return contextDoc.data();

        const userDoc = await db.collection('users').doc(userId).get();
        if (userDoc.exists && userDoc.data().businessContext) return userDoc.data().businessContext;
    } catch (err) {
        console.warn(`Could not fetch business context for ${userId}:`, err.message);
    }
    return {
        businessName: "This Business",
        businessDescription: "a professional service provider",
        servicesOffered: "various professional services",
        faqs: "",
        leadQualificationCriteria: "a client asking about pricing, booking, or a specific service",
        tone: "professional",
        handoffTrigger: "when the client requests to speak with a human or mentions an urgent issue",
        industry: "general",
    };
}

// --- Product Catalog ---
async function getProductCatalog(userId) {
    try {
        const snap = await db.collection('product_catalog')
            .where('businessId', '==', userId).limit(1).get();
        if (snap.empty) return null;

        const data = snap.docs[0].data();
        if (!data.columns || !data.rows || data.rows.length === 0) return null;

        let table = "Product Catalog:\n";
        table += "| " + data.columns.join(" | ") + " |\n";
        table += "| " + data.columns.map(() => "---").join(" | ") + " |\n";
        data.rows.forEach(row => {
            table += "| " + data.columns.map(col => row[col] || "-").join(" | ") + " |\n";
        });
        return table;
    } catch (err) {
        console.warn(`Could not fetch product catalog for ${userId}:`, err.message);
        return null;
    }
}

// ============================================================
// CALL 1: CLASSIFY  -- FREE model, ~1 API call per message
// ============================================================
async function callAIForClassification(messageBody, userId) {
    if (!OPENROUTER_API_KEY) return { isLead: false, intent: "API Key Missing" };

    const ctx = await getBusinessContext(userId);
    console.log(`\nAI: Classifying message: "${messageBody.substring(0, 50)}..."`);

    const systemPrompt =
        `You are a lead classifier for ${ctx.businessName} (${ctx.businessDescription}). ` +
        `Services: ${ctx.servicesOffered}. ` +
        `Is the client message a genuine business inquiry (pricing, service, consultation)? ` +
        `Or is it spam, a greeting with no intent, or a system message? ` +
        `Reply ONLY with valid JSON, no markdown. Schema: { "isLead": boolean, "intent": string }`;

    try {
        const text = await openRouterRequest(systemPrompt, `Message: "${messageBody}"`, MODEL_FREE, true);
        const result = JSON.parse(text);
        console.log(`Classification: isLead=${result.isLead}, Intent='${result.intent}'`);
        return result;
    } catch (error) {
        console.error("Classification failed:", error.message);
        return { isLead: false, intent: "Classification Error" };
    }
}

// ============================================================
// CALL 2: QUALIFY  -- NO API CALL, pure JavaScript logic
// The old Gemini prompt said: "3+ messages AND specific intent = qualified".
// We enforce that rule directly here. Zero cost, zero latency, same result.
// ============================================================
function qualifyLead(totalMessages, intent) {
    const isSpecific = intent && intent.length > 10 &&
        !["greeting", "hello", "hi", "unknown", "none"].some(w => intent.toLowerCase().includes(w));

    let isQualified = false;
    let priority = "Low";

    if (totalMessages >= 3 && isSpecific) {
        isQualified = true;
        priority = "High";
    } else if (totalMessages === 2 && isSpecific) {
        priority = "Medium";
    }

    console.log(`Qualification (JS): messages=${totalMessages}, qualified=${isQualified}, priority=${priority}`);
    return { isQualified, priority };
}

// ============================================================
// CALL 3: EXTRACT  -- FREE model, only runs when lead is qualified
// ============================================================
async function callAIForExtraction(messageBody) {
    if (!OPENROUTER_API_KEY) return { name: null, email: null };

    const systemPrompt =
        `Extract the full name and email address from the message. ` +
        `If either is missing or ambiguous, return null for that field. ` +
        `Reply ONLY with valid JSON. Schema: { "name": string|null, "email": string|null }`;

    try {
        const text = await openRouterRequest(systemPrompt, `Message: "${messageBody}"`, MODEL_FREE, true);
        return JSON.parse(text);
    } catch (error) {
        return { name: null, email: null };
    }
}

// ============================================================
// CALL 4: REPLY  -- PAID model, the only call that costs credits
// This is what the customer reads. Quality matters here.
// ============================================================
async function callAIForReply(messageBody, intent, isReturningClient, isQualified, missingName, missingEmail, totalMessages, userId, catalogTable = null) {
    if (!OPENROUTER_API_KEY) return "Reply failed: API Key Missing.";

    const ctx = await getBusinessContext(userId);

    // Determine which stage of the funnel we're in
    let stage = 1;
    if (isQualified && !missingName && !missingEmail) stage = 3;
    else if (isQualified && (missingName || missingEmail)) stage = 2;

    console.log(`AI: Generating reply (Stage: ${stage}, Qualified: ${isQualified})`);

    const tone =
        ctx.tone === "friendly" ? "Use a warm, friendly tone." :
        ctx.tone === "casual"   ? "Use a casual, conversational tone." :
                                  "Use a professional, courteous tone.";

    const handoff = ctx.handoffTrigger
        ? `Escalate to a human when: ${ctx.handoffTrigger}.`
        : "Offer to connect with a team member when the client is fully qualified.";

    const base =
        `You are an AI assistant for ${ctx.businessName}: ${ctx.businessDescription}. ` +
        `Services: ${ctx.servicesOffered}. ${tone} ` +
        `Stage ${stage} rules: ` +
        `Stage 1 = answer helpfully, build rapport, do NOT offer to connect to a human. ` +
        `Stage 2 = acknowledge the query but ask for contact details first, do NOT answer the specific question yet. ` +
        `Stage 3 = ${handoff} ` +
        `NEVER offer human handoff unless in Stage 3. ` +
        (ctx.faqs     ? `FAQs: ${ctx.faqs} `              : "") +
        (catalogTable ? `Product catalog: ${catalogTable} ` : "");

    let systemPrompt;
    if (stage === 2) {
        const missing = (missingName && missingEmail) ? "full name and email address"
                      : missingName  ? "full name"
                      : "email address";
        systemPrompt = `${base} Politely acknowledge the client's question, then ask for their ${missing} before you can continue. Two sentences max.`;
    } else if (stage === 3) {
        systemPrompt = `${base} Thank the client, confirm their details are saved, and tell them a specialist will follow up about: ${intent}.`;
    } else {
        systemPrompt = `${base} Answer concisely (3-4 points max). The client has sent ${totalMessages} messages so far.`;
    }

    try {
        return await openRouterRequest(systemPrompt, `Client message: "${messageBody}"`, MODEL_REPLY, false);
    } catch (error) {
        return "Thank you for your message. We are currently experiencing high volume but will reply shortly!";
    }
}

// ============================================================
// MAIN PROCESSOR
// ============================================================
function startLeadProcessor() {
    if (!db) return;

    const q = db.collection(RAW_MESSAGES_COLLECTION).where('processed', '==', false);
    console.log(`\nAI Processor: Listening on '${RAW_MESSAGES_COLLECTION}'...`);

    q.onSnapshot(async (snapshot) => {
        snapshot.docChanges().forEach(async (change) => {
            if (change.type !== "added") return;

            const doc     = change.doc;
            const message = doc.data();
            const docId   = doc.id;

            const userId      = message.userId      || "unknown_user";
            const phoneNumber = message.phoneNumber  || "unknown_phone";

            console.log(`\nProcessing message ${docId.substring(0, 10)} for [${userId}]`);

            // --- Step 1: Classify (FREE) ---
            const classification = await callAIForClassification(message.body, userId);

            const errorIntents = ["Classification Error", "API Error", "API Key Missing", "No Candidate", "No JSON Part"];
            if (errorIntents.includes(classification.intent)) {
                console.log(`API Failure on classify. Marking pending_retry.`);
                await db.collection(RAW_MESSAGES_COLLECTION).doc(docId).update({
                    processed: true, status: "pending_retry", errorReason: classification.intent
                });
                return;
            }

            let autoReplyText           = null;
            let isReturningClient       = false;
            let totalMessagesFromClient = 0;
            let isQualified             = false;
            let leadPriority            = "Low";
            let qualifiedLeadRecord     = null;

            // --- Step 2: Check lead history in Firestore ---
            if (classification.isLead) {
                const existingLeads = await db.collection(LEADS_COLLECTION)
                    .where('userId', '==', userId)
                    .orderBy('timestamp', 'desc')
                    .limit(1)
                    .get();

                isReturningClient = !existingLeads.empty;
                if (isReturningClient) totalMessagesFromClient = existingLeads.docs[0].data().messageCount || 1;
                totalMessagesFromClient += 1;

                const existingQualified = await db.collection(QUALIFIED_LEADS_COLLECTION)
                    .where('userId', '==', userId).limit(1).get();
                if (!existingQualified.empty) {
                    qualifiedLeadRecord = existingQualified.docs[0];
                    isQualified         = true;
                    leadPriority        = qualifiedLeadRecord.data().priority || "High";
                }
            }

            // --- Step 3: Qualify (FREE — pure JS, no API call) ---
            if (classification.isLead && !isQualified) {
                const qualResult = qualifyLead(totalMessagesFromClient, classification.intent);
                isQualified  = qualResult.isQualified;
                leadPriority = qualResult.priority;
            }

            // --- Step 4: Extract name/email (FREE — only if qualified) ---
            let missingName  = true;
            let missingEmail = true;

            if (isQualified) {
                const extracted = await callAIForExtraction(message.body);
                let updates = {};

                if (qualifiedLeadRecord) {
                    const curName  = qualifiedLeadRecord.data().name;
                    const curEmail = qualifiedLeadRecord.data().email;

                    if (!curName  && extracted.name)  updates.name  = extracted.name;
                    else if (curName)  missingName  = false;

                    if (!curEmail && extracted.email) updates.email = extracted.email;
                    else if (curEmail) missingEmail = false;

                    missingName  = missingName  && !updates.name;
                    missingEmail = missingEmail && !updates.email;

                    if (Object.keys(updates).length > 0) await qualifiedLeadRecord.ref.update(updates);
                } else if (extracted.name || extracted.email) {
                    missingName  = !extracted.name;
                    missingEmail = !extracted.email;
                }
            }

            const newLead = classification.isLead && !isReturningClient;

            let updateData = {
                processed: true, status: "success",
                isLead: classification.isLead, newLead,
                userId, phoneNumber,
                intent: classification.intent,
                messageCount: totalMessagesFromClient,
                isQualified, priority: leadPriority,
            };

            // --- Step 5: Generate reply (PAID — credits spent here only) ---
            if (classification.isLead) {
                const catalogTable = await getProductCatalog(userId);
                autoReplyText = await callAIForReply(
                    message.body, classification.intent, isReturningClient,
                    isQualified, missingName, missingEmail,
                    totalMessagesFromClient, userId, catalogTable
                );

                if (autoReplyText) {
                    autoReplyText += "\n\n*Note: You are talking to an AI Agent. It can make mistakes.*";
                }

                updateData.replyPending  = true;
                updateData.autoReplyText = autoReplyText;

                // Save qualified lead record
                if (isQualified && !qualifiedLeadRecord) {
                    await db.collection(QUALIFIED_LEADS_COLLECTION).add({
                        userId, phoneNumber, rawMessageId: docId, contactId: message.from,
                        intent: classification.intent, lastMessageBody: message.body,
                        priority: leadPriority, messageCount: totalMessagesFromClient,
                        autoReplyText, timestamp: admin.firestore.Timestamp.now(),
                        name:  missingName  ? null : "Extracted",
                        email: missingEmail ? null : "Extracted",
                    });
                }

                // Save new lead record
                if (newLead) {
                    await db.collection(LEADS_COLLECTION).add({
                        userId, phoneNumber, contactId: message.from,
                        intent: classification.intent, firstMessageBody: message.body,
                        messageCount: totalMessagesFromClient,
                        timestamp: admin.firestore.Timestamp.now(),
                    });
                }
            }

            // --- Step 6: Mark message as processed ---
            await db.collection(RAW_MESSAGES_COLLECTION).doc(docId).update(updateData);
            console.log(`Done: message ${docId.substring(0, 10)} processed.`);
        });
    });
}

initializeFirebase();
startLeadProcessor();
