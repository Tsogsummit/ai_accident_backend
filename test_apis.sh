#!/bin/bash

BASE_URL="http://localhost:3000"
TOKEN=""

echo "🧪 Testing AI Accident Detection APIs"
echo "======================================"
echo ""

# 1. Register хэрэглэгч
echo "📝 1. Registering user..."
REGISTER_RESPONSE=$(curl -s -X POST "$BASE_URL/auth/register" \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+97699887766",
    "password": "test123456",
    "name": "Test User",
    "email": "test@example.com"
  }')

echo "$REGISTER_RESPONSE" | jq '.'
echo ""

# 2. Login хийх
echo "🔐 2. Logging in..."
LOGIN_RESPONSE=$(curl -s -X POST "$BASE_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+97699887766",
    "password": "test123456"
  }')

TOKEN=$(echo "$LOGIN_RESPONSE" | jq -r '.token')
echo "Token: ${TOKEN:0:50}..."
echo ""

# 3. Profile авах
echo "👤 3. Getting user profile..."
curl -s -X GET "$BASE_URL/auth/profile" \
  -H "Authorization: Bearer $TOKEN" | jq '.'
echo ""

# 4. Осол мэдээлэх
echo "🚨 4. Reporting accident..."
ACCIDENT_RESPONSE=$(curl -s -X POST "$BASE_URL/accidents/report" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "latitude": 47.9186,
    "longitude": 106.9172,
    "severity": "moderate",
    "description": "Test accident report",
    "witnesses_count": 2
  }')

ACCIDENT_ID=$(echo "$ACCIDENT_RESPONSE" | jq -r '.accident.id')
echo "$ACCIDENT_RESPONSE" | jq '.'
echo ""

# 5. Ослын жагсаалт авах
echo "📋 5. Getting accidents list..."
curl -s -X GET "$BASE_URL/accidents?limit=5" \
  -H "Authorization: Bearer $TOKEN" | jq '.accidents[] | {id, severity, status, description}'
echo ""

# 6. Statistics авах
echo "📊 6. Getting statistics..."
curl -s -X GET "$BASE_URL/accidents/stats" \
  -H "Authorization: Bearer $TOKEN" | jq '.'
echo ""

echo "✅ API tests completed!"
