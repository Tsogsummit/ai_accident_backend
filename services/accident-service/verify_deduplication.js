const axios = require('axios');

const ACCIDENT_SERVICE_URL = 'http://localhost:3002';
const USER_SERVICE_URL = 'http://localhost:3001';

// Helper to generate random phone number
function generatePhone() {
    return '+976' + Math.floor(10000000 + Math.random() * 90000000);
}

async function registerUser(name) {
    const phone = generatePhone();
    const password = 'Password123'; // Valid password

    try {
        console.log(`Registering user ${name} with phone ${phone}...`);
        const res = await axios.post(`${USER_SERVICE_URL}/auth/register`, {
            phone,
            name,
            password,
            email: `test_${Date.now()}_${Math.random()}@example.com`
        });

        if (res.data.success) {
            console.log(`✅ Registered ${name} (ID: ${res.data.user.id})`);
            return res.data.accessToken;
        }
    } catch (error) {
        console.error(`❌ Failed to register ${name}:`, error.response?.data || error.message);
        throw error;
    }
}

async function runTests() {
    console.log('🚀 Starting Deduplication Verification with Real Auth...');

    try {
        // 1. Get Tokens
        const token1 = await registerUser('User One');
        const token2 = await registerUser('User Two');

        const headers1 = {
            'Authorization': 'Bearer ' + token1,
            'Content-Type': 'application/json'
        };

        const headers2 = {
            'Authorization': 'Bearer ' + token2,
            'Content-Type': 'application/json'
        };

        // --- Test Case 1: Same User Merging ---
        console.log('\n--- Test Case 1: Same User Merging ---');

        // 1. Report Accident A (User 1)
        const accidentA = {
            latitude: 47.9188,
            longitude: 106.9176,
            description: 'Test Accident A - Original (User 1)',
            imageUrl: 'http://example.com/a.jpg'
        };

        console.log('Reporting Accident A (User 1)...');
        const resA = await axios.post(ACCIDENT_SERVICE_URL + '/accidents', accidentA, { headers: headers1 });
        console.log('Accident A Result:', resA.data.message, 'ID:', resA.data.data.id);
        const accidentAId = resA.data.data.id;

        // 2. Report Accident A AGAIN (User 1) - Should Merge
        console.log('Reporting Accident A AGAIN (User 1) - Should Merge...');
        const resA2 = await axios.post(ACCIDENT_SERVICE_URL + '/accidents', accidentA, { headers: headers1 });
        console.log('Accident A2 Result:', resA2.data.message);

        if (resA2.data.isNewAccident === false && resA2.data.data.id === accidentAId) {
            console.log('✅ SUCCESS: Same user report was merged.');
            console.log('Report Count:', resA2.data.reportCount);
        } else {
            console.error('❌ FAILURE: Same user report was NOT merged correctly.');
            console.log('Response:', resA2.data);
        }

        // --- Test Case 2: Different User Merging ---
        console.log('\n--- Test Case 2: Different User Merging ---');

        // 3. Report Accident B (User 2) - Nearby - Should Merge into A
        const accidentB = {
            latitude: 47.9195, // Nearby
            longitude: 106.9176,
            description: 'Test Accident B - Nearby (User 2)',
            imageUrl: 'http://example.com/b.jpg'
        };

        console.log('Reporting Accident B (User 2) - Should Merge into A...');
        const resB = await axios.post(ACCIDENT_SERVICE_URL + '/accidents', accidentB, { headers: headers2 });
        console.log('Accident B Result:', resB.data.message);

        if (resB.data.isNewAccident === false && resB.data.data.id === accidentAId) {
            console.log('✅ SUCCESS: Different user report was merged into Accident A.');
            console.log('Report Count:', resB.data.reportCount);
        } else {
            console.error('❌ FAILURE: Different user report was NOT merged correctly.');
            console.log('Response:', resB.data);
        }


    } catch (error) {
        console.error('❌ Test Failed:', error.message);
        if (error.response) {
            console.error('Response Status:', error.response.status);
            console.error('Response Data:', error.response.data);
        }
    }
}

runTests();
