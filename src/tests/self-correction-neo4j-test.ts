import { Neo4jMemoryStore } from "../app/graphStore.js";
import { normalizeRelation, type INormalizedRelation } from "../app/graphNormalization.js";
import { detectConflicts } from "../app/conflictDetector.js";
import "dotenv/config"
import {
    createSelfCorrectionEngine,
} from "../app/selfCorrection.js";


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

const engine = createSelfCorrectionEngine(store);

const current = [
    normalizeRelation({
        subject: "ravi",
        predicate: "LIKES",
        object: "coffee",
        confidence: 0.95,
    }),
]as INormalizedRelation[];

const historical = [
    {
        subject: "ravi",
        predicate: "DISLIKES",
        object: "coffee",
        confidence: 0.90,
    },
];

const analysis = detectConflicts({
    current,
    historical,
    evidence: [
        "I love coffee.",
    ],
});

console.log("\n===== CONFLICT =====");
console.dir(analysis, { depth: null });

const report = await engine.applyCorrections(
    analysis.findings,
);

console.log("\n===== SELF CORRECTION =====");
console.dir(report, { depth: null });

console.log("\n===== VERIFY GRAPH =====");

const result = await store.runQuery(
    `
    MATCH (a:Entity {name: $subject})
          -[r:RELATES_TO]->
          (b:Entity {name: $object})
    RETURN
        a.name AS subject,
        r.predicate AS predicate,
        b.name AS object
    ORDER BY r.predicate
    `,
    {
        subject: "ravi",
        object: "coffee",
    },
);

console.dir(result.records, { depth: null });

await store.close();