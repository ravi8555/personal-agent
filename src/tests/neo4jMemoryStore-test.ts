import "dotenv/config"
import {Neo4jMemoryStore} from "../app/graphStore.js"
import type { IMemoryExtraction } from '../app/memoryExtraction.js'

import path from 'path';

// Load .env from the project root (adjust path as needed)
// dotenv.config({ path: path.resolve(process.cwd(), '.env') });


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

const extraction: IMemoryExtraction = {
    summary: "Ravi discussed his beverage preferences.",
    facts : [
        "Ravi does not like coffee.",
        "Ravi prefers tea."
    ],
   relations: [
        {
            subject: "Ravi",
            predicate: "does not like",
            object: "Coffee",
            confidence: 0.95
        },
        {
            subject: "Ravi",
            predicate: "prefers",
            object: "Tea",
            confidence: 0.90
        }
    ],

    feedback: [
        {
            type: "preference",
            text: "Ravi prefers tea over coffee."
        }
    ],

    extractedAt : new Date().toString()
}

await store.initialize()
await store.saveExtraction(extraction)
await store.saveExtraction(extraction);


console.log("Extraction saved!");


// run 
// npm exec tsx src/neo4jMemoryStore-test.ts