const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const path = require('path');

// Configuration
const ACCIDENT_SERVICE_URL = 'http://localhost:3002';
const AUTH_URL = 'http://localhost:3001';

// Test Data
const TEST_USER = {
    phone: '+976' + (80000000 + Math.floor(Math.random() * 10000000)), // Ensure 8 digits
    password: 'Password123',
    name: 'Gemini Tester'
};

const TEST_IMAGE_PATH = path.join(__dirname, 'test_accident.jpg');

// Helper: Create dummy image if not exists
if (!fs.existsSync(TEST_IMAGE_PATH)) {
    fs.writeFileSync(TEST_IMAGE_PATH, 'fake image content');
}

async function registerUser() {
    try {
        await axios.post(`${AUTH_URL}/auth/register`, TEST_USER);
    } catch (e) {
        console.log('Register error (ignored if exists):', e.response?.data || e.message);
    }
    const res = await axios.post(`${AUTH_URL}/auth/login`, {
        phone: TEST_USER.phone,
        password: TEST_USER.password
    });
    console.log('Login response:', res.data);
    return res.data.accessToken;
}

async function runTest() {
    console.log('🚀 Starting Gemini Flow Verification...');

    try {
        // 1. Login
        const token = await registerUser();
        console.log('✅ Logged in');

        // 2. Upload Image
        const formData = new FormData();
        formData.append('image', fs.createReadStream(TEST_IMAGE_PATH));
        formData.append('latitude', '47.9184');
        formData.append('longitude', '106.9177');
        formData.append('description', 'Test accident image');

        console.log('📸 Uploading image...');
        const res = await axios.post(`${ACCIDENT_SERVICE_URL}/accidents/report-image`, formData, {
            headers: {
                'Authorization': `Bearer ${token}`,
                ...formData.getHeaders()
            }
        });

        console.log('✅ Response:', res.data);

        if (res.data.success && res.data.analysis.isAccident) {
            console.log('🎉 SUCCESS: Accident created from Image!');
            console.log('   Accident ID:', res.data.data.id);
            console.log('   AI Description:', res.data.analysis.description);
        } else {
            console.error('❌ FAILURE: Accident not created or AI rejected it.');
        }

    } catch (error) {
        console.error('❌ Test Failed:', error.response?.data || error.message);
    } finally {
        // Cleanup
        if (fs.existsSync(TEST_IMAGE_PATH)) fs.unlinkSync(TEST_IMAGE_PATH);
    }
}

runTest();
