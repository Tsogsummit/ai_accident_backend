const axios = require('axios');

const API_URL = 'http://localhost:3002';
const TEST_USER = {
    phone: '+97699112233',
    password: 'Password123!'
};

async function verifyHealth() {
    try {
        console.log('🚀 Starting Health Check Verification...');

        // 1. Login
        console.log('🔑 Logging in...');
        let token;
        try {
            const loginRes = await axios.post('http://localhost:3001/auth/login', TEST_USER);
            token = loginRes.data.accessToken;
            console.log('✅ Logged in');
        } catch (e) {
            console.log('⚠️ Login failed, trying to register...');
            await axios.post('http://localhost:3001/auth/register', {
                ...TEST_USER,
                name: 'Test Admin'
            });
            const loginRes = await axios.post('http://localhost:3001/auth/login', TEST_USER);
            token = loginRes.data.accessToken;
            console.log('✅ Registered and Logged in');
        }

        // 2. Check Health
        console.log('🏥 Checking Admin Health Endpoint...');
        const healthRes = await axios.get(`${API_URL}/admin/health`, {
            headers: { Authorization: `Bearer ${token}` }
        });

        console.log('✅ Health Check Response:', JSON.stringify(healthRes.data, null, 2));

        if (healthRes.data.status === 'healthy' &&
            healthRes.data.components.geminiService.status === 'healthy') {
            console.log('🎉 SUCCESS: All systems healthy!');
        } else {
            console.log('⚠️ WARNING: Some systems are unhealthy or degraded.');
        }

    } catch (error) {
        console.error('❌ Verification Failed:', error.response ? error.response.data : error.message);
    }
}

verifyHealth();
