import { Agent } from "../app/agent.js";
import { Neo4jMemoryStore } from "../app/graphStore.js";

import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Validate required environment variables
if (!process.env.NEO4J_URI || !process.env.NEO4J_USER || !process.env.NEO4J_PASSWORD) {
    console.error('NEO4J_URI:', process.env.NEO4J_URI);
    console.error('NEO4J_USER:', process.env.NEO4J_USER);
    console.error('NEO4J_PASSWORD:', process.env.NEO4J_PASSWORD ? '****' : 'undefined');
    throw new Error('Missing required Neo4j environment variables. Please check NEO4J_URI, NEO4J_USER, and NEO4J_PASSWORD.');
}

const store = new Neo4jMemoryStore({
    uri: process.env.NEO4J_URI,
    user: process.env.NEO4J_USER,
    password: process.env.NEO4J_PASSWORD,
    database: process.env.NEO4J_DATABASE || 'neo4j'
});

await store.initialize();

const agent = Agent.builder()
    .setInstructions(`
        You are a personal assistant.
    `)
    .withMemoryStore(store)
    .build();

const extraction = {
    summary: "Ravi explicitly says that he likes coffee.",

    facts: [
        "Ravi loves coffee."
    ],

    relations: [
        {
            subject: "ravi",
            predicate: "LIKES",
            object: "coffee",
            confidence: 0.95,
        }
    ],

    feedback: [],

    extractedAt: new Date().toISOString(),
};

console.log("\n===== ANALYZING FEEDBACK =====");

const feedback =
    await agent.analyzeConversationFeedback(extraction);

console.log("\n===== FEEDBACK RESULT =====");
console.dir(feedback, { depth: null });

await store.close();