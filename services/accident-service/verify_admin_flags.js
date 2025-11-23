const axios = require('axios');

const ACCIDENT_SERVICE_URL = 'http://localhost:3002';
const USER_SERVICE_URL = 'http://localhost:3001';

// Helper to generate random phone number
function generatePhone() {
    return '+976' + Math.floor(10000000 + Math.random() * 90000000);
}

async function registerUser(name) {
    const phone = generatePhone();
    const password = 'Password123';

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
            return { token: res.data.accessToken, userId: res.data.user.id };
        }
    } catch (error) {
        console.error(`❌ Failed to register ${name}:`, error.response?.data || error.message);
        throw error;
    }
}

async function reportFalseAlarm(accidentId, token) {
    try {
        const headers = { 'Authorization': 'Bearer ' + token };
        await axios.post(`${ACCIDENT_SERVICE_URL}/accidents/${accidentId}/report-false`, {}, { headers });
        console.log(`✅ Reported false alarm for accident ${accidentId}`);
    } catch (error) {
        console.error(`❌ Failed to report false alarm:`, error.response?.data || error.message);
        throw error;
    }
}

async function runTests() {
    console.log('🚀 Starting Admin Flags Verification...');

    try {
        // 1. Setup Users
        const reporter = await registerUser('Reporter');
        const user1 = await registerUser('False Reporter 1');
        const user2 = await registerUser('False Reporter 2');
        const user3 = await registerUser('False Reporter 3');
        const admin = await registerUser('Admin User');

        // 2. Report Accident
        console.log('\n--- Step 1: Report Accident ---');
        const accidentData = {
            latitude: 47.9220,
            longitude: 106.9220,
            description: 'Admin Flag Test Accident'
        };
        const resReport = await axios.post(ACCIDENT_SERVICE_URL + '/accidents', accidentData, {
            headers: { 'Authorization': 'Bearer ' + reporter.token }
        });
        const accidentId = resReport.data.data.id;
        console.log(`✅ Reported Accident ID: ${accidentId}`);

        // 3. Report False Alarms (1, 2, then 3 times)
        console.log('\n--- Step 2: Accumulate False Reports ---');

        // 0 False Reports
        let res = await axios.get(`${ACCIDENT_SERVICE_URL}/accidents?minFalseReports=3`, {
            headers: { 'Authorization': 'Bearer ' + admin.token }
        });
        if (res.data.data.find(a => a.id === accidentId)) {
            console.error('❌ Accident appeared with 0 false reports (Expected: Hidden)');
        } else {
            console.log('✅ Accident hidden with 0 false reports.');
        }

        // 1 False Report
        await reportFalseAlarm(accidentId, user1.token);

        // 2 False Reports
        await reportFalseAlarm(accidentId, user2.token);

        // 3 False Reports (Threshold)
        await reportFalseAlarm(accidentId, user3.token);

        // 4. Verify Visibility with minFalseReports=3
        console.log('\n--- Step 3: Verify Admin Visibility ---');
        res = await axios.get(`${ACCIDENT_SERVICE_URL}/accidents?minFalseReports=3`, {
            headers: { 'Authorization': 'Bearer ' + admin.token }
        });

        const found = res.data.data.find(a => a.id === accidentId);
        if (found) {
            console.log(`✅ SUCCESS: Accident ${accidentId} appeared with ${found.false_report_count} false reports.`);
        } else {
            console.error(`❌ FAILURE: Accident ${accidentId} did NOT appear with 3 false reports!`);
            console.log('Returned data:', res.data.data);
        }

    } catch (error) {
        console.error('❌ Test Failed:', error.message);
    }
}

runTests();
