// ai-processor/index.js
// This service monitors new messages in Firestore, classifies them using Gemini, 
// and prepares an auto-reply for the WhatsApp client to execute.

require('dotenv').config(); 
const admin = require('firebase-admin');

// --- Global Variables ---
const RAW_MESSAGES_COLLECTION = 'raw_messages';
const LEADS_COLLECTION = 'leads';

// --- Gemini API Configuration ---
// NOTE: We assume the GEMINI_API_KEY is available in your .env file
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_API_MODEL = "gemini-2.5-flash"; // Using flash for speed and classification capability
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_API_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
const MAX_RETRIES = 3;

let db;


// --- Firebase Initialization ---
function initializeFirebase() {
    try {
        const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
        if (!serviceAccountPath) {
            console.error("❌ AI Processor: FIREBASE_SERVICE_ACCOUNT_PATH not set in .env.");
            process.exit(1);
        }
        const serviceAccount = require(serviceAccountPath);
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
 * Calls Gemini to classify the lead and return a structured JSON object.
 * @param {string} messageBody - The text of the client message.
 * @returns {Promise<{isLead: boolean, intent: string} | null>}
 */
async function callGeminiForClassification(messageBody) {
    if (!GEMINI_API_KEY) {
        console.error("❌ GEMINI_API_KEY is missing. Cannot call AI service.");
        return { isLead: false, intent: "API Key Missing" };
    }
    
    console.log(`\n🤖 AI: Classifying message: "${messageBody.substring(0, 50)}..."`);
    
    const systemPrompt = "You are an expert lead classifier for an immigration consulting firm. Your task is to analyze the client's message and determine if it is a qualified sales lead (i.e., requesting a service, consultation, or general inquiry about visa/immigration) or if it is spam/a system message. Respond ONLY with a JSON object conforming to the schema. Do NOT include any extra text, markdown wrappers (like ```json), or explanations.";
    const userQuery = `Client Message: "${messageBody}"`;
    
    // Define the required JSON output structure (Structured Output)
    const responseSchema = {
        type: "OBJECT",
        properties: {
            "isLead": { "type": "BOOLEAN", "description": "True if the message is a qualified lead asking for service/consultation." },
            "intent": { "type": "STRING", "description": "A concise description of the client's goal (e.g., 'Student Visa Enquiry', 'PR Application Question', 'General Greeting')." }
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

        if (!response.ok) {
            const errorBody = await response.text();
            console.error(`❌ AI API HTTP Error: Status ${response.status} ${response.statusText}`);
            console.error(`--- Raw API Error Body ---:\n${errorBody.substring(0, 500)}`);
            return { isLead: false, intent: "API Error" };
        }
        
        const result = await response.json();
        
        const candidate = result.candidates?.[0];

        if (!candidate) {
            console.error("❌ Gemini returned no candidates. Raw result:", JSON.stringify(result, null, 2));
            return { isLead: false, intent: "No Candidate" };
        }

        const jsonText = candidate.content?.parts?.[0]?.text;
        
        if (!jsonText) {
             console.error("❌ Gemini returned candidate but no valid JSON text part.");
             return { isLead: false, intent: "No JSON Part" };
        }
        
        const classification = JSON.parse(jsonText);
        console.log(`✅ AI Classification Result: isLead=${classification.isLead}, Intent='${classification.intent}'`);
        
        return classification;

    } catch (error) {
        console.error("❌ AI Classification failed during fetch/parse:", error.message);
        return { isLead: false, intent: "Classification Error" }; // Default safe value
    }
}


/**
 * Calls Gemini to generate a professional auto-reply.
 * @param {string} messageBody - The original client message.
 * @param {string} intent - The classified intent.
 * @param {boolean} isReturningClient - True if client has an existing record in LEADS_COLLECTION. 
 * @returns {Promise<string>} - The generated reply text.
 */
async function callGeminiForReply(messageBody, intent, isReturningClient = false) { 
    if (!GEMINI_API_KEY) return "Reply failed: API Key Missing.";

    console.log(`🤖 AI: Generating reply for intent: '${intent}' (Returning: ${isReturningClient})`);
    
    // MODIFIED LOGIC: Adjust prompt based on whether the client is returning
    let systemPrompt;
    
    if (isReturningClient) {
        systemPrompt = `You are a professional, friendly, and efficient immigration consultant's assistant. Your goal is to provide a brief, welcoming, and reassuring automated response to a **returning client**. The response must be 3-4 sentences maximum. **Acknowledge that they have contacted us before** and thank them for reaching out again with the intent: "${intent}". Confirm receipt of their message and ask what a good time for a brief, personalized consultation call is, mentioning you'll look up their previous details.`;
    } else {
        systemPrompt = `You are a professional, friendly, and efficient immigration consultant's assistant. Your goal is to provide a brief, welcoming, and reassuring automated response to a new lead. The response must be 3-4 sentences maximum. Acknowledge their interest in the identified intent: "${intent}". Confirm receipt of their message and ask what a good time for a brief, personalized consultation call is.`;
    }

    const userQuery = `The client's original message was: "${messageBody}"`;

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
        
        if (!response.ok) throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);

        const result = await response.json();
        
        const replyText = result.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!replyText) throw new Error("Gemini returned no reply text.");

        console.log(`✅ AI Reply Generated: "${replyText.substring(0, 50)}..."`);
        return replyText;

    } catch (error) {
        console.error("❌ AI Reply Generation failed:", error.message);
        return "Thank you for your message. We are currently experiencing high volume but will reply to your inquiry shortly!";
    }
}


/**
 * Main processor loop. Sets up a listener for unprocessed messages.
 */
function startLeadProcessor() {
    if (!db) {
        console.error("AI Processor cannot start: Firestore DB not initialized.");
        return;
    }

    const q = db.collection(RAW_MESSAGES_COLLECTION)
        .where('processed', '==', false);

    console.log(`\n🔄 AI Processor: Starting live queue monitor on '${RAW_MESSAGES_COLLECTION}'.`);

    q.onSnapshot(async (snapshot) => {
        snapshot.docChanges().forEach(async (change) => {
            if (change.type === "added") {
                const doc = change.doc;
                const message = doc.data();
                const docId = doc.id;

                // Make sure userId exists
                const userId = message.userId || "unknown_user";
                const phoneNumber = message.phoneNumber || "unknown_phone";

                console.log(`📨 [${userId}] Processing message ${docId.substring(0, 10)}...`);

                // --- Step 1: Classification ---
                const classification = await callGeminiForClassification(message.body);

                let autoReplyText = null;
                let isReturningClient = false; 

                // --- Step 2: Check for existing client/lead ---
                if (classification.isLead) {
                    const existingLead = await db.collection(LEADS_COLLECTION)
                        .where('userId', '==', userId)
                        .where('phoneNumber', '==', phoneNumber)
                        .limit(1)
                        .get();
                    
                    isReturningClient = !existingLead.empty;
                    console.log(`🔍 [${userId}] Is returning client: ${isReturningClient}`);
                }
                
                // --- Step 3: Define newLead status (UPDATED LOGIC) ---
                // newLead is TRUE if the message is a qualified lead AND it's not from a returning client.
                // isLead is TRUE regardless of prior contact, as long as the message is a sales inquiry.
                const newLead = classification.isLead && !isReturningClient;

                let updateData = {
                    processed: true,
                    isLead: classification.isLead,
                    newLead: newLead, // ADDED: New field for status
                    userId,      
                    phoneNumber, 
                };

                // --- Step 4: Generate Auto Reply (Only for classified leads) ---
                if (classification.isLead) {
                    if (!["Classification Error", "API Error", "API Key Missing", "No Candidate", "No JSON Part"].includes(classification.intent)) {
                        
                        // Pass the new context flag to get the appropriate reply
                        autoReplyText = await callGeminiForReply(message.body, classification.intent, isReturningClient); 

                        updateData.replyPending = true;
                        updateData.autoReplyText = autoReplyText;

                        // --- Step 5: Save Lead (Conditional on being a NEW client) ---
                        if (newLead) { // Only save to LEADS_COLLECTION if this is the first time contact is a lead
                            await db.collection(LEADS_COLLECTION).add({
                                userId,           
                                phoneNumber,
                                rawMessageId: docId,
                                contactId: message.from,
                                intent: classification.intent,
                                firstMessageBody: message.body,
                                autoReplyText: autoReplyText,
                                timestamp: admin.firestore.Timestamp.now(),
                            });
                            console.log(`✅ [${userId}] NEW Lead saved to '${LEADS_COLLECTION}'.`);
                        } else {
                            console.log(`✅ [${userId}] Message from RETURNING client (isLead=true, newLead=false). Skipping new lead save to '${LEADS_COLLECTION}'.`);
                            // Returning leads get an auto-reply but don't create a new record in the LEADS_COLLECTION.
                        }

                    } else {
                        console.log(`❌ [${userId}] Classification failed internally. Skipping auto-reply.`);
                    }
                } else {
                    // If not classified as a lead, isLead=false and newLead=false (by definition above).
                    console.log(`❌ [${userId}] Classified as not a lead.`);
                }

                // --- Step 6: Update raw message ---
                // This happens for ALL messages, ensuring 'processed' is set to true.
                await db.collection(RAW_MESSAGES_COLLECTION).doc(docId).update(updateData);
                console.log(`✅ [${userId}] Updated raw message ${docId.substring(0, 10)} with processed status. isLead: ${classification.isLead}, newLead: ${newLead}.`);
            }
        });
    });
}



// --- Execute Main Function ---
initializeFirebase();
startLeadProcessor();