// src/tests/test-connection.ts
import 'dotenv/config';
import neo4j from 'neo4j-driver';

async function testConnection() {
    console.log('🔍 Testing Neo4j AuraDB Connection...\n');
    
    // Check environment variables
    console.log('📋 Environment Variables:');
    console.log(`  NEO4J_URI: ${process.env.NEO4J_URI || '❌ Not set'}`);
    console.log(`  NEO4J_USER: ${process.env.NEO4J_USER || '❌ Not set'}`);
    console.log(`  NEO4J_PASSWORD: ${process.env.NEO4J_PASSWORD ? '✅ Set' : '❌ Not set'}`);
    console.log(`  NEO4J_DATABASE: ${process.env.NEO4J_DATABASE || '⚠️ Not set (will use default)'}`);
    console.log();

    // Validate required variables
    if (!process.env.NEO4J_URI) {
        throw new Error('NEO4J_URI is not set in environment variables');
    }
    if (!process.env.NEO4J_USER) {
        throw new Error('NEO4J_USER is not set in environment variables');
    }
    if (!process.env.NEO4J_PASSWORD) {
        throw new Error('NEO4J_PASSWORD is not set in environment variables');
    }

    // Create driver
    const driver = neo4j.driver(
        process.env.NEO4J_URI,
        neo4j.auth.basic(
            process.env.NEO4J_USER,
            process.env.NEO4J_PASSWORD
        )
    );

    try {
        // Test connection
        console.log('🔄 Connecting to Neo4j AuraDB...');
        await driver.verifyConnectivity();
        console.log('✅ Successfully connected to Neo4j AuraDB!\n');

        // Get server info
        const serverInfo = await driver.getServerInfo();
        console.log('📊 Server Information:');
        console.log(`  Address: ${serverInfo.address}`);
        // console.log(`  Protocol: ${serverInfo.protocol}`);
        // console.log(`  Version: ${serverInfo.version}`);
        console.log();

        // Test a simple query
        const session = driver.session({
            database: process.env.NEO4J_DATABASE || 'neo4j'
        });

        console.log('🔄 Running test query...');
        const result = await session.run('RETURN 1 + 1 AS result');
        // console.log(`✅ Query result: 1 + 1 = ${result.records[0].get('result')}`);
        console.log();

        // Show database info
        const dbResult = await session.run('SHOW DATABASES');
        console.log('🗄️ Available Databases:');
        dbResult.records.forEach(record => {
            console.log(`  - ${record.get('name')} (${record.get('currentStatus')})`);
        });

        await session.close();
        console.log('\n✅ All tests passed! Connection is working correctly.');

    } catch (error) {
        console.error('\n❌ Connection failed:');
        if (error instanceof Error) {
            console.error(`  ${error.message}`);
        } else {
            console.error('  Unknown error:', error);
        }
    } finally {
        await driver.close();
    }
}

// Run the test
testConnection();