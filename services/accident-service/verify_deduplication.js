const axios = require('axios');
const jwt = require('jsonwebtoken');

const API_URL = 'http://localhost:3002';
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Generate a test token
const userId = 1;
const token = jwt.sign({ userId, email: 'test@example.com', role: 'user' }, JWT_SECRET, { expiresIn: '1h' });

const headers = {
    'Authorization': 'Bearer ' + token,
    'Content-Type': 'application/json'
};

async function runTests() {
    console.log('🚀 Starting Deduplication Verification...');

    try {
        // --- Test Case 1: Proximity Deduplication ---
        console.log('\n--- Test Case 1: Proximity Deduplication ---');

        // 1. Report Accident A
        const accidentA = {
            latitude: 47.9188,
            longitude: 106.9176,
            description: 'Test Accident A - Original',
            imageUrl: 'http://example.com/a.jpg'
        };

        console.log('Reporting Accident A...');
        const resA = await axios.post(API_URL + '/accidents', accidentA, { headers });
        console.log('Accident A Result:', resA.data.message, 'ID:', resA.data.data.id);
        const accidentAId = resA.data.data.id;

        // 2. Report Accident B (Nearby)
        const accidentB = {
            latitude: 47.9195,
            longitude: 106.9176,
            description: 'Test Accident B - Nearby Duplicate',
            imageUrl: 'http://example.com/b.jpg'
        };

        console.log('Reporting Accident B (Nearby)...');
        const resB = await axios.post(API_URL + '/accidents', accidentB, { headers });
        console.log('Accident B Result:', resB.data.message);

        if (resB.data.isNewAccident === false && resB.data.data.id === accidentAId) {
            console.log('✅ SUCCESS: Accident B was merged into Accident A.');
            console.log('Report Count:', resB.data.reportCount);
        } else {
            console.error('❌ FAILURE: Accident B was NOT merged correctly.');
            console.log('Response:', resB.data);
        }

        // --- Test Case 2: Video ID Deduplication ---
        console.log('\n--- Test Case 2: Video ID Deduplication ---');

        const videoId = Math.floor(Math.random() * 1000000);

        // 1. Report Accident C with Video ID
        const accidentC = {
            latitude: 47.9000,
            longitude: 106.9000,
            description: 'Test Accident C - With Video',
            videoId: videoId
        };

        console.log('Reporting Accident C (Video ID: ' + videoId + ')...');
        const resC = await axios.post(API_URL + '/accidents', accidentC, { headers });
        console.log('Accident C Result:', resC.data.message, 'ID:', resC.data.data.id);
        const accidentCId = resC.data.data.id;

        // 2. Report Accident D with SAME Video ID
        const accidentD = {
            latitude: 47.8000,
            longitude: 106.8000,
            description: 'Test Accident D - Same Video, Far Away',
            videoId: videoId
        };

        console.log('Reporting Accident D (Same Video ID)...');
        const resD = await axios.post(API_URL + '/accidents', accidentD, { headers });
        console.log('Accident D Result:', resD.data.message);

        if (resD.data.isNewAccident === false && resD.data.data.id === accidentCId) {
            console.log('✅ SUCCESS: Accident D was merged into Accident C based on Video ID.');
        } else {
            console.error('❌ FAILURE: Accident D was NOT merged based on Video ID.');
            console.log('Response:', resD.data);
        }

    } catch (error) {
        console.error('❌ Test Failed:', error.message);
        if (error.response) {
            console.error('Response Status:', error.response.status);
            console.error('Response Data:', error.response.data);
        } else if (error.request) {
            console.error('No response received.');
        } else {
            console.error('Error details:', error);
        }
    }
}

runTests();
