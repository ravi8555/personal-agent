import {buildWriteQueries} from '../app/graphCypher.js'
import type { IMemoryExtraction } from '../app/memoryExtraction.js'

// const extraction: IMemoryExtraction = {
//     summary: "Ravi discussed his beverage preferences.",
//     facts : [
//         "Ravi does not like coffee.",
//         "Ravi prefers tea."
//     ],
//     // relations: [
//     //     {
//     //         subject: "Ravi",
//     //         predicate: "does not like",
//     //         object: "Coffee",
//     //         confidence: 0.95
//     //     },
//     //     {
//     //         subject: "Ravi",
//     //         predicate: "prefers",
//     //         object: "Tea",
//     //         confidence: 0.90
//     //     }
//     // ],

//     relations: [
//     {
//         subject: "Ravi",
//         predicate: "likes",
//         object: "Coffee"
//     },
//     {
//         subject: "RAVI",
//         predicate: "enjoys",
//         object: "coffee"
//     },
//     {
//         subject: " Ravi ",
//         predicate: "LIKES",
//         object: " Coffee "
//     }
// ],

//     feedback: [
//         {
//             type: "preference",
//             text: "Ravi prefers tea over coffee."
//         }
//     ],

//     extractedAt : new Date().toString()
// }

// cycle -1
// const extraction: IMemoryExtraction = {
//     summary: "Ravi discussed his beverage preferences.",
//     facts: [
//         "Ravi does not like coffee.",
//         "Ravi prefers tea.",
//     ],
//     relations: [
//         {
//             subject: "Ravi",
//             predicate: "dislikes",
//             object: "Coffee",
//             confidence: 0.95,
//         },
//         {
//             subject: "Ravi",
//             predicate: "prefers",
//             object: "Tea",
//             confidence: 0.90,
//         },
//     ],
//     feedback: [
//         {
//             type: "preference",
//             text: "Ravi prefers tea over coffee.",
//         },
//     ],
//     extractedAt: new Date().toString(),
// };

// cycle -2
const extraction: IMemoryExtraction = {
    summary: "Ravi changed his preference and now likes coffee.",
    facts: [
        "Ravi now likes coffee.",
    ],
    relations: [
        {
            subject: "Ravi",
            predicate: "likes",
            object: "Coffee",
            confidence: 0.95,
        },
    ],
    feedback: [
        {
            type: "preference",
            text: "Ravi now likes coffee.",
        },
    ],
    extractedAt: new Date().toString(),
};

const queries = buildWriteQueries(extraction)

for (const [index, query] of queries.entries()) {
    console.log(`\n===== QUERY ${index + 1} =====`);
    console.log(query.cypher);
    console.log("\nPARAMS:");
    console.dir(query.params, { depth: null });
}

console.dir(queries, { depth: null });


// run 
// pnpm exec tsx src/memory-test.ts