import {Agent, AgentBuilder} from './app/agent.js'
import type { ITool } from './app/agent.js'
import axios from 'axios'

import { exec } from 'child_process';

import { normalizePredicate, normalizeRelation, normalizeRelations } from './app/graphNormalization.js';
import { entityKey } from './app/graphSchema.js';

const weatherTool :ITool = {
    name : 'fetchWeatherInfo',
    description : 'fetch weather real time data by city name',
    doc : 'fetchWeatherInfo(cityName: string): WeatherReport',
    async executor(cityName) {
        const url = `https://wttr.in/${cityName.toLowerCase()}?format=%C+%t`;
        const response = await axios.get(url, { responseType: 'text' });
        return JSON.stringify({ cityName, weatherInfo: response.data });
    },
}

const cliAccessTool : ITool = {
    name : 'execCli',
    description : 'Runs Cli command on user machine and return the output',
    doc : 'execCli(cli:string):CLIResponse',
    executor(cmd){
        return new Promise((res ,rej) =>{
            exec(cmd, (err, out) =>{
                if(err) return res(`There was an error ${err}`);
                else return res(out)
            })
        })
    }
}

async function init() {
    const agent: Agent = Agent.builder()
        .setInstructions(`You are an expert coding agent`)
        .tool(weatherTool)
        .tool(cliAccessTool)
        .build()

        agent.attachInterceptor(message => console.log(`Message : ${message.role } ${message.content}`))

        const result = 
        // await agent.run('My name is Ravi.I live in Akola.I prefer React over Angular.I dont like coffee.')

        await agent.run("I prefer tea over coffee.");
            
        // // check memory
        //     console.log("\n===== MEMORY =====");
        //     console.log(
        //         agent.getMemoryProcessor().readHistory()
        //     );

        // check actual extraction
//         const scheduler = agent.getMemoryScheduler();
//         await scheduler.tick();
//            console.log(
//     agent.getMemoryExtractions()
// );

/* check graphnormalization and graphschema */

// console.log(normalizePredicate('likes'));
// console.log(normalizePredicate('enjoys'));
// console.log(normalizePredicate('does not like'));
// console.log(normalizePredicate('lives in'));
// console.log(normalizePredicate('LIVES_IN'));
// console.log(normalizePredicate('some random relation'));

// console.log(entityKey(' Ravi '));
// console.log(entityKey('RAVI'));
// console.log(entityKey('  Ravi   Kumar  '));


// const relation = normalizeRelation({
//     subject: ' Ravi ',
//     predicate: 'enjoys',
//     object: ' Coffee ',
//     confidence: 0.95,
// });

// console.log(relation);


// const relations = normalizeRelations([
//     {
//         subject: 'Ravi',
//         predicate: 'likes',
//         object: 'Coffee',
//     },
//     {
//         subject: 'Ravi',
//         predicate: 'enjoys',
//         object: 'Coffee',
//     },
//     {
//         subject: 'Ravi',
//         predicate: 'does not like',
//         object: 'Tea',
//     },
//     {
//         subject: 'Ravi',
//         predicate: 'lives in',
//         object: 'Akola',
//     },
// ]);

// console.dir(relations, { depth: null });


/* test complete memory pipeline*/
const scheduler = agent.getMemoryScheduler();

// await scheduler.tick();

// console.dir(
//     agent.getMemoryExtractions(),
//     { depth: null }
// );

/* test Verify the scheduler processes only new history*/
// console.log(agent.getMemoryExtractions().length);

await scheduler.tick();

console.log(agent.getMemoryExtractions().length);

        console.log(result![result?.length! -1]);
        

}

init()