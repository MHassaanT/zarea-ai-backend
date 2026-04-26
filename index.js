// ai-processor/index.js
// This service monitors new messages in Firestore, classifies them using Gemini, 
// and prepares an auto-reply for the WhatsApp client to execute.

require('dotenv').config(); 
const admin = require('firebase-admin');

// --- Global Variables ---
const RAW_MESSAGES_COLLECTION = 'raw_messages';
const LEADS_COLLECTION = 'leads';
const QUALIFIED_LEADS_COLLECTION = 'qualified_leads';

// --- Gemini API Configuration ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_API_MODEL = "gemini-2.5-flash"; 
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_API_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

let db;

// --- Firebase Initialization ---
function initializeFirebase() {
    try {
        const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_API_BASE64;
        
        if (!serviceAccountBase64) {
            console.error("❌ AI Processor: FIREBASE_SERVICE_ACCOUNT_API_BASE64 not set in .env.");
            process.exit(1);
        }

        const serviceAccountJson = Buffer.from(serviceAccountBase64, 'base64').toString('utf8');
        const serviceAccount = JSON.parse(serviceAccountJson);

        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        db = admin.firestore();
        console.log("🔥 AI Processor: Firebase Admin Initialized");
        
    } catch (error) {
        console.error("❌ AI Processor: Error initializing Firebase Admin:", error.message);
        process.exit(1);
    }
}

/**
 * Fetches business context from Firestore for a given userId.
 * Falls back to generic defaults if no context is set.
 */
async function getBusinessContext(userId) {
  try {
    const contextDoc = await db.collection('business_context').doc(userId).get();
    if (contextDoc.exists) {
      return contextDoc.data();
    }
    // Fallback: read from users collection
    const userDoc = await db.collection('users').doc(userId).get();
    if (userDoc.exists && userDoc.data().businessContext) {
      return userDoc.data().businessContext;
    }
  } catch (err) {
    console.warn(`⚠️ Could not fetch business context for ${userId}:`, err.message);
  }
  // Generic fallback if no context configured yet
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

/**
 * Fetches product catalog for a given userId and formats it as a text table.
 */
async function getProductCatalog(userId) {
  try {
    const catalogSnapshot = await db.collection('product_catalog')
      .where('businessId', '==', userId)
      .limit(1)
      .get();
    
    if (catalogSnapshot.empty) return null;
    
    const data = catalogSnapshot.docs[0].data();
    if (!data.columns || !data.rows || data.rows.length === 0) return null;
    
    // Format as a simple markdown-ish table for the AI
    let table = `Product Catalog for ${userId}:\n`;
    table += "| " + data.columns.join(" | ") + " |\n";
    table += "| " + data.columns.map(() => "---").join(" | ") + " |\n";
    
    data.rows.forEach(row => {
      table += "| " + data.columns.map(col => row[col] || "-").join(" | ") + " |\n";
    });
    
    return table;
  } catch (err) {
    console.warn(`⚠️ Could not fetch product catalog for ${userId}:`, err.message);
    return null;
  }
}

/**
 * Calls Gemini to classify the lead.
 */
async function callGeminiForClassification(messageBody, userId) {
    if (!GEMINI_API_KEY) return { isLead: false, intent: "API Key Missing" };
    
    const ctx = await getBusinessContext(userId);

    console.log(`\n🤖 AI: Classifying message: "${messageBody.substring(0, 50)}..."`);
    
    const systemPrompt = `You are an expert lead classifier for ${ctx.businessName}, which is ${ctx.businessDescription}. 
Services offered: ${ctx.servicesOffered}.
Your task is to analyze the client's message and determine if it is a qualified sales lead (i.e., requesting a service, consultation, pricing, or general inquiry about the business) or if it is spam, a greeting with no intent, or a system message.
Respond ONLY with a JSON object conforming to the schema. Do NOT include any extra text, markdown wrappers (like \`\`\`json), or explanations.`;
    const userQuery = `Client Message: "${messageBody}"`;
    
    const responseSchema = {
        type: "OBJECT",
        properties: {
            "isLead": { "type": "BOOLEAN", "description": "True if the message is a qualified lead asking for service/consultation." },
            "intent": { "type": "STRING", "description": "A concise description of the client's goal." }
        },
        "required": ["isLead", "intent"]
    };

    const payload = {
        contents: [{ parts: [{ text: userQuery }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: responseSchema,
        }
    };

    try {
        const response = await fetch(GEMINI_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) return { isLead: false, intent: "API Error" };
        
        const result = await response.json();
        const jsonText = result.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!jsonText) return { isLead: false, intent: "No JSON Part" };
        
        const classification = JSON.parse(jsonText);
        console.log(`✅ AI Classification Result: isLead=${classification.isLead}, Intent='${classification.intent}'`);
        return classification;
    } catch (error) {
        console.error("❌ AI Classification failed:", error.message);
        return { isLead: false, intent: "Classification Error" }; 
    }
}

/**
 * Calls Gemini to evaluate Qualified Lead status.
 */
async function callGeminiForQualification(currentMessage, totalMessagesFromClient, currentIntent, userId) {
    const ctx = await getBusinessContext(userId);

    const systemPrompt = `You are a lead qualification specialist for ${ctx.businessName}.
A qualified lead for this business is: ${ctx.leadQualificationCriteria}.
Analyze the client's current message, their stated intent, and the length of the conversation (${totalMessagesFromClient} messages so far).
Determine if the client is genuinely interested and engaged.
If the client has sent 3 or more messages AND the intent is specific (not just a greeting), set 'isQualified' to true.
Set 'priority' based on engagement: 'High' for 3+ specific messages, 'Medium' for 2, 'Low' for 1.
Respond ONLY with a JSON object.`;
    const userQuery = `Current Message: "${currentMessage}". Current Intent: "${currentIntent}". Total Messages: ${totalMessagesFromClient}`;

    const responseSchema = {
        type: "OBJECT",
        properties: {
            "isQualified": { "type": "BOOLEAN" },
            "priority": { "type": "STRING" }
        },
        "required": ["isQualified", "priority"]
    };
    
    const payload = {
        contents: [{ parts: [{ text: userQuery }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { responseMimeType: "application/json", responseSchema: responseSchema }
    };

    try {
        const response = await fetch(GEMINI_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const result = await response.json();
        const jsonText = result.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!jsonText) throw new Error("No JSON part");
        return JSON.parse(jsonText);
    } catch (error) {
        return { isQualified: false, priority: "Low" };
    }
}

/**
 * Calls Gemini to extract Name and Email.
 */
async function callGeminiForExtraction(messageBody) {
    if (!GEMINI_API_KEY) return { name: null, email: null };

    const systemPrompt = "You are an expert data parser. Analyze the user's message and strictly extract only their full name and a valid email address. If a value is not found or is ambiguous, return null for that field. Respond ONLY with a JSON object.";
    const userQuery = `Client Message: "${messageBody}"`;
    
    const responseSchema = {
        type: "OBJECT",
        properties: {
            "name": { "type": "STRING" },
            "email": { "type": "STRING" }
        },
        "required": ["name", "email"]
    };

    const payload = {
        contents: [{ parts: [{ text: userQuery }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { responseMimeType: "application/json", responseSchema: responseSchema }
    };

    try {
        const response = await fetch(GEMINI_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const result = await response.json();
        const jsonText = result.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!jsonText) return { name: null, email: null };
        return JSON.parse(jsonText);
    } catch (error) {
        return { name: null, email: null };
    }
}

/**
 * Calls Gemini to generate a professional auto-reply.
 * INCLUDES PHASE 1 (Gateway) & PHASE 3 (Funnel Rules)
 */
async function callGeminiForReply(messageBody, intent, isReturningClient, isQualified, missingName, missingEmail, totalMessagesFromClient, userId, catalogTable = null) { 
    if (!GEMINI_API_KEY) return "Reply failed: API Key Missing.";

    const ctx = await getBusinessContext(userId);

    let conversationStage = 1;
    if (isQualified && (!missingName && !missingEmail)) conversationStage = 3;
    else if (isQualified && (missingName || missingEmail)) conversationStage = 2;

    console.log(`🤖 AI: Generating reply (Stage: ${conversationStage}, Qualified: ${isQualified})`);
    
    const toneInstruction = ctx.tone === "friendly"
      ? "Use a warm, friendly tone."
      : ctx.tone === "casual"
      ? "Use a casual, conversational tone."
      : "Use a professional, courteous tone.";

    const handoffInstruction = ctx.handoffTrigger
      ? `Escalate to a human team member when: ${ctx.handoffTrigger}.`
      : "Offer to connect the client with a team member when they are fully qualified.";

    const funnelRules = `
CRITICAL FUNNEL RULES:
- You are an AI assistant for ${ctx.businessName}: ${ctx.businessDescription}.
- Services: ${ctx.servicesOffered}.
- ${toneInstruction}
- You are currently in Stage ${conversationStage} of the conversation.
- Stage 1 (Exploration): Answer questions, provide value, build rapport. Do NOT offer to book a call or speak with a human yet.
- Stage 2 (Lead Capture): You MUST intercept the conversation. Acknowledge the client's question politely, but tell them you need their contact details before proceeding. Do NOT answer their specific question yet.
- Stage 3 (Conversion): The client is fully qualified and has provided contact details. ${handoffInstruction}

NEVER offer to connect with a human or book a consultation unless you are strictly in Stage 3.
${ctx.faqs ? `\nRelevant FAQs you can reference:\n${ctx.faqs}` : ""}
${catalogTable ? `\nProduct Catalog (reference this for product details):\n${catalogTable}` : ""}
`;

    let systemPrompt;
    
    if (conversationStage === 2) {
        let promptPart = "";
        if (missingName && missingEmail) promptPart = "their Full Name and Email Address";
        else if (missingName) promptPart = "their Full Name";
        else if (missingEmail) promptPart = "their Email Address";
        
        systemPrompt = `You are an AI assistant for ${ctx.businessName}. ${funnelRules}\n\nThe client is asking a question, but we need their contact info first. Politely acknowledge their query, but strictly tell them you need ${promptPart} before you can provide specific advice or proceed further. Do not answer their specific question yet. Keep it to two sentences. ${toneInstruction}`;
    } else if (conversationStage === 3) {
        systemPrompt = `You are an AI assistant for ${ctx.businessName}. ${funnelRules}\n\nThank the client for providing their information. Confirm their details are saved, briefly address any lingering part of their query, and let them know a specialist will follow up shortly regarding: ${intent}. ${toneInstruction}`;
    } else {
        systemPrompt = `You are an AI assistant for ${ctx.businessName}. ${funnelRules}\n\nAnswer the client's question concisely (3-4 points max). They have sent ${totalMessagesFromClient} messages so far. Be helpful but remember your Stage 1 constraints. ${toneInstruction}`;
    }

    const userQuery = `The client's message was: "${messageBody}".`;

    const payload = {
        contents: [{ parts: [{ text: userQuery }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] }
    };

    try {
        const response = await fetch(GEMINI_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        const result = await response.json();
        return result.candidates?.[0]?.content?.parts?.[0]?.text || "Thank you for your message. We will reply shortly!";
    } catch (error) {
        return "Thank you for your message. We are currently experiencing high volume but will reply to your inquiry shortly!";
    }
}

/**
 * Main processor loop. Sets up a listener for unprocessed messages.
 */
function startLeadProcessor() {
    if (!db) return;

    const q = db.collection(RAW_MESSAGES_COLLECTION).where('processed', '==', false);
    console.log(`\n🔄 AI Processor: Starting live queue monitor on '${RAW_MESSAGES_COLLECTION}'.`);

    q.onSnapshot(async (snapshot) => {
        snapshot.docChanges().forEach(async (change) => {
            if (change.type === "added") {
                const doc = change.doc;
                const message = doc.data();
                const docId = doc.id;

                const userId = message.userId || "unknown_user";
                const phoneNumber = message.phoneNumber || "unknown_phone";

                console.log(`📨 [${userId}] Processing message ${docId.substring(0, 10)}...`);

                const classification = await callGeminiForClassification(message.body, userId);

                // --- Phase 4, Fix 2: Silent API Failures Handling ---
                const errorIntents = ["Classification Error", "API Error", "API Key Missing", "No Candidate", "No JSON Part"];
                if (errorIntents.includes(classification.intent)) {
                    console.log(`❌ [${userId}] API Failure. Marking as pending_retry.`);
                    await db.collection(RAW_MESSAGES_COLLECTION).doc(docId).update({
                        processed: true, // Mark true to stop the immediate infinite listener loop
                        status: "pending_retry", // Flag it so a cron job or manual script can retry later
                        errorReason: classification.intent
                    });
                    return; // Exit early
                }

                let autoReplyText = null;
                let isReturningClient = false; 
                let totalMessagesFromClient = 0;
                let isQualified = false; 
                let leadPriority = "Low";
                let qualifiedLeadRecord = null; 

                // --- Step 2: Context ---
                if (classification.isLead) {
                    const existingLeadSnapshot = await db.collection(LEADS_COLLECTION)
                        .where('userId', '==', userId)
                        .orderBy('timestamp', 'desc') 
                        .limit(1)
                        .get();
                    
                    isReturningClient = !existingLeadSnapshot.empty;
                    if (isReturningClient) totalMessagesFromClient = existingLeadSnapshot.docs[0].data().messageCount || 1;
                    totalMessagesFromClient += 1; 
                    
                    const existingQualifiedLead = await db.collection(QUALIFIED_LEADS_COLLECTION).where('userId', '==', userId).limit(1).get();
                    if (!existingQualifiedLead.empty) {
                        qualifiedLeadRecord = existingQualifiedLead.docs[0];
                        isQualified = true;
                        leadPriority = qualifiedLeadRecord.data().priority || "High"; 
                    }
                }
                
                // --- Step 3: Qualification Check ---
                if (classification.isLead && !isQualified) {
                    const qualificationResult = await callGeminiForQualification(message.body, totalMessagesFromClient, classification.intent, userId);
                    isQualified = qualificationResult.isQualified;
                    leadPriority = qualificationResult.priority;
                }

                // --- Step 4: Data Extraction ---
                let missingName = true;
                let missingEmail = true;

                if (isQualified) {
                    const extractedData = await callGeminiForExtraction(message.body);
                    let updateQualifiedData = {};
                    
                    if (qualifiedLeadRecord) {
                        const currentName = qualifiedLeadRecord.data().name;
                        const currentEmail = qualifiedLeadRecord.data().email;

                        if (!currentName && extractedData.name) updateQualifiedData.name = extractedData.name;
                        else if (currentName) missingName = false;
                        
                        if (!currentEmail && extractedData.email) updateQualifiedData.email = extractedData.email;
                        else if (currentEmail) missingEmail = false;
                        
                        missingName = missingName && !updateQualifiedData.name;
                        missingEmail = missingEmail && !updateQualifiedData.email;
                        
                        if (Object.keys(updateQualifiedData).length > 0) {
                            await qualifiedLeadRecord.ref.update(updateQualifiedData);
                        }
                    } else if (extractedData.name || extractedData.email) {
                        missingName = !extractedData.name;
                        missingEmail = !extractedData.email;
                    }
                }
                
                const newLead = classification.isLead && !isReturningClient;

                let updateData = {
                    processed: true,
                    status: "success",
                    isLead: classification.isLead,
                    newLead: newLead, 
                    userId,      
                    phoneNumber,  
                    intent: classification.intent, 
                    messageCount: totalMessagesFromClient, 
                    isQualified: isQualified, 
                    priority: leadPriority, 
                };

                // --- Step 6: Generate Auto Reply ---
                if (classification.isLead) {
                    const catalogTable = await getProductCatalog(userId);
                    // Passed the totalMessagesFromClient to help Gemini gauge the stage
                    autoReplyText = await callGeminiForReply(message.Body, classification.intent, isReturningClient, isQualified, missingName, missingEmail, totalMessagesFromClient, userId, catalogTable); 

                    // --- Phase 2: Legal Disclaimer Appendage ---
                    if (autoReplyText) {
                        autoReplyText += "\n\n*Note: You are talking to an AI Agent. It can make mistakes.*";
                    }

                    updateData.replyPending = true;
                    updateData.autoReplyText = autoReplyText;

                    // --- Step 7: Save Records ---
                    if (isQualified && !qualifiedLeadRecord) {
                        await db.collection(QUALIFIED_LEADS_COLLECTION).add({
                            userId, phoneNumber, rawMessageId: docId, contactId: message.from,
                            intent: classification.intent, lastMessageBody: message.body,
                            priority: leadPriority, messageCount: totalMessagesFromClient,
                            autoReplyText: autoReplyText, timestamp: admin.firestore.Timestamp.now(),
                            name: missingName ? null : "Extracted", // Simplified for brevity
                            email: missingEmail ? null : "Extracted",
                        });
                    }
                    
                    if (newLead) { 
                        await db.collection(LEADS_COLLECTION).add({
                            userId, phoneNumber, contactId: message.from, intent: classification.intent,
                            firstMessageBody: message.body, messageCount: totalMessagesFromClient, timestamp: admin.firestore.Timestamp.now(),
                        });
                    } 
                }

                // --- Step 8: Update raw message ---
                await db.collection(RAW_MESSAGES_COLLECTION).doc(docId).update(updateData);
                console.log(`✅ [${userId}] Updated raw message ${docId.substring(0, 10)} with processed status.`);
            }
        });
    });
}

initializeFirebase();
startLeadProcessor();
