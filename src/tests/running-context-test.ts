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

const agent = Agent.builder()
    .setInstructions(`
        You are a helpful personal assistant.
    `)
    .withMemoryStore(store)
    .build();

await store.initialize();

console.log("\n===== ADDING CONVERSATION =====");

agent.getMemory().addUser(
    "I prefer tea over coffee."
);

agent.getMemory().addUser(
    "I want to buy a coffee machine."
);

console.log("\n===== BUILDING RUNNING CONTEXT =====");

const context = await agent.buildRunningContext();

console.log("\n===== RUNNING CONTEXT =====");
console.dir(context, { depth: null });

console.log("\n===== RUNNING CONTEXT TEXT =====");

console.log(context?.text ?? "NO RUNNING CONTEXT");

await store.close();