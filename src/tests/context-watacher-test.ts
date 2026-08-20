import type { from } from "node:stream/iter";
// import {ContextWatcher, defaultTopicAnalyzer} from '../app/contextWatcher.js'
// import { Agent} from '../app/agent.js'
// import {Neo4jMemoryStore} from "../app/graphStore.js"


// // Validate required environment variables
// if (!process.env.NEO4J_URI || !process.env.NEO4J_USER || !process.env.NEO4J_PASSWORD) {
//     console.error('NEO4J_URI:', process.env.NEO4J_URI);
//     console.error('NEO4J_USER:', process.env.NEO4J_USER);
//     console.error('NEO4J_PASSWORD:', process.env.NEO4J_PASSWORD ? '****' : 'undefined');
//     throw new Error('Missing required Neo4j environment variables. Please check NEO4J_URI, NEO4J_USER, and NEO4J_PASSWORD.');
// }

// const store = new Neo4jMemoryStore({
//     uri: process.env.NEO4J_URI,
//     user: process.env.NEO4J_USER,
//     password: process.env.NEO4J_PASSWORD,
//     database: process.env.NEO4J_DATABASE || 'neo4j'
// });


// async function init() {
//     const agent: Agent = Agent.builder()
//         .setInstructions(`You are an expert coding agent`)
//         .build()
//         agent.attachInterceptor(message => console.log(`Message : ${message.role } ${message.content}`))
//         await agent.run("I prefer tea over coffee.");


// const retriever = async(topic: { topic: string; context?: string }) => {
//     const result = await store.runQuery(
//         `
//         MATCH (u:Entity {name: "ravi"})
//               -[r:RELATES_TO]->
//               (e:Entity)
//         WHERE e.name = $topic
//         RETURN
//             u.name AS subject,
//             r.predicate AS predicate,
//             e.name AS object
//         LIMIT 10
//         `,
//         { topic: topic.toLowerCase() }
//     );
// const watcher = new ContextWatcher({
//     memory: agent.getMemory(),
//     analyzer: defaultTopicAnalyzer,
//     retriever
// });

//     return result;
// };

        
// const watcher = new ContextWatcher({
//     memory: agent.getMemory(),

//     analyzer: defaultTopicAnalyzer,

//     retriever: async (topic) => {
//         console.log("GRAPH SEARCH FOR:", topic);

//         return [
//             `User has a previous relationship with ${topic}.`
//         ];
//     }
// });

// await agent.run("I want to buy a coffee machine.");

// await watcher.tick();

// console.log("TOPIC:");
// console.log(watcher.getCurrentTopic());

// console.log("KNOWLEDGE:");
// console.log(watcher.getRelevantKnowledge());

// }
// init() 

import { ContextWatcher, defaultTopicAnalyzer } from '../app/contextWatcher.js';
import { Agent } from '../app/agent.js';
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

async function init() {
    try {
        const agent: Agent = Agent.builder()
            .setInstructions(`You are an expert coding agent`)
            .build();
            
        agent.attachInterceptor(message => console.log(`Message : ${message.role} ${message.content}`));
        await agent.run("I prefer tea over coffee.");

        // Define retriever with proper type handling
        const retriever = async (topic: { topic: string; context?: string }) => {
            console.log("🔍 GRAPH SEARCH FOR:", topic.topic);
            
            try {
                // Query Neo4j
                const result: any = await store.runQuery(
                    `
                    MATCH (u:Entity {name: "ravi"})
                          -[r:RELATES_TO]->
                          (e:Entity)
                    WHERE e.name CONTAINS $topic
                    RETURN
                        u.name AS subject,
                        r.predicate AS predicate,
                        e.name AS object
                    LIMIT 10
                    `,
                    { topic: topic.topic.toLowerCase() }
                );

                // Debug: Log the actual result type and structure
                console.log('📊 Result type:', typeof result);
                console.log('📊 Result structure:', JSON.stringify(result, null, 2));

                // Handle different result formats
                let resultsArray: any[] = [];

                // Check if result is an array
                if (Array.isArray(result)) {
                    resultsArray = result;
                } 
                // Check if result has a records property (Neo4j driver format)
                else if (result && typeof result === 'object' && 'records' in result) {
                    resultsArray = result.records || [];
                }
                // Check if result is an object with values
                else if (result && typeof result === 'object') {
                    // Try to convert object to array of values
                    resultsArray = Object.values(result).filter(val => val !== null && val !== undefined);
                }
                // If result is a single record
                else if (result && typeof result === 'object' && result.subject) {
                    resultsArray = [result];
                }

                console.log(`📊 Found ${resultsArray.length} result(s)`);

                if (resultsArray.length === 0) {
                    return [`No previous relationship found for ${topic.topic}.`];
                }

                // Format and return results
                const formattedResults = resultsArray.map((record: any) => {
                    // Handle both direct properties and Neo4j record format
                    const subject = record.subject || record.get?.('subject') || 'Unknown';
                    const predicate = record.predicate || record.get?.('predicate') || 'related to';
                    const object = record.object || record.get?.('object') || topic.topic;
                    return `${subject} ${predicate} ${object}`;
                });

                return formattedResults;

            } catch (error) {
                console.error('❌ Error in retriever:', error);
                return [`Error retrieving data for ${topic.topic}: ${error instanceof Error ? error.message : 'Unknown error'}`];
            }
        };

        // Create watcher with the retriever
        const watcher = new ContextWatcher({
            memory: agent.getMemory(),
            analyzer: defaultTopicAnalyzer,
            retriever: retriever
        });

        await agent.run("I want to buy a coffee machine.");
        await watcher.tick();

        console.log("\n📌 TOPIC:");
        console.log(watcher.getCurrentTopic());

        console.log("\n📚 KNOWLEDGE:");
        console.log(watcher.getRelevantKnowledge());

    } catch (error) {
        console.error('❌ Error in init:', error);
    }
}

init();

