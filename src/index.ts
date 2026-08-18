import {Agent, AgentBuilder} from './app/agent.js'
import type { ITool } from './app/agent.js'
import axios from 'axios'

import { exec } from 'child_process';

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

        const result = await agent.run('My name is Ravi.I live in Akola.I prefer React over Angular.I dont like coffee.')
            
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

        console.log(result![result?.length! -1]);
        

}

init()