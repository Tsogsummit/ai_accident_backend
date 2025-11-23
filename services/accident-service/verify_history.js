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

async function runTests() {
    console.log('🚀 Starting History Visibility Verification...');

    try {
        // 1. Register User
        const user = await registerUser('History User');
        const headers = {
            'Authorization': 'Bearer ' + user.token,
            'Content-Type': 'application/json'
        };

        // 2. Report Accident
        console.log('\n--- Step 1: Report Accident ---');
        const accidentData = {
            latitude: 47.9200,
            longitude: 106.9200,
            description: 'History Test Accident'
        };
        const resReport = await axios.post(ACCIDENT_SERVICE_URL + '/accidents', accidentData, { headers });
        const accidentId = resReport.data.data.id;
        console.log(`✅ Reported Accident ID: ${accidentId}`);

        // 3. Check History (Should be visible)
        console.log('\n--- Step 2: Check History (Status: Reported) ---');
        const resHistory1 = await axios.get(`${ACCIDENT_SERVICE_URL}/accidents?userOnly=true`, { headers });
        const found1 = resHistory1.data.data.find(a => a.id === accidentId);
        if (found1) {
            console.log('✅ Accident found in history.');
        } else {
            console.error('❌ Accident NOT found in history!');
            process.exit(1);
        }

        // 4. Change Status to false_alarm (Simulate Admin)
        console.log('\n--- Step 3: Admin marks as False Alarm ---');
        // Note: In real app, admin would do this. Here we use the same user if allowed, or we might need admin token.
        // Assuming the endpoint allows it for now or we just test the visibility.
        // If this fails due to permissions, we'll know.
        try {
            await axios.put(`${ACCIDENT_SERVICE_URL}/accidents/${accidentId}/status`, { status: 'false_alarm' }, { headers });
            console.log('✅ Status updated to false_alarm');
        } catch (err) {
            console.log('⚠️ Could not update status (maybe permission). Skipping update check if it failed.');
            // If we can't update, we can't test the disappearance.
            // But let's assume for this test environment we might be able to, or we need to fix permissions.
            // Actually, let's try to update it directly in DB if possible? No, can't access DB directly easily here.
            // Let's hope the user can update their own accident status or we have a way.
            // Wait, usually users can't change status.
            // I will use a "hack" or assume I can register an admin? No admin registration flow.
            // I will try to use the PUT endpoint. If it fails, I will manually update DB via a separate command if needed, 
            // but for now let's see if it works.
            console.error('❌ Failed to update status:', err.response?.data || err.message);
            return;
        }

        // 5. Check History AGAIN (Should STILL be visible)
        console.log('\n--- Step 4: Check History (Status: False Alarm) ---');
        const resHistory2 = await axios.get(`${ACCIDENT_SERVICE_URL}/accidents?userOnly=true`, { headers });
        const found2 = resHistory2.data.data.find(a => a.id === accidentId);

        if (found2) {
            console.log(`✅ SUCCESS: Accident ${accidentId} is STILL visible in history with status '${found2.status}'.`);
        } else {
            console.error(`❌ FAILURE: Accident ${accidentId} DISAPPEARED from history after status change!`);
            console.log('History items:', resHistory2.data.data.map(a => ({ id: a.id, status: a.status })));
        }

    } catch (error) {
        console.error('❌ Test Failed:', error.message);
    }
}

runTests();
