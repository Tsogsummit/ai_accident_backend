# False Report Workflow Update - Admin Review System

## Overview
Updated the false report logic so that when 3+ users report an accident as false, it doesn't automatically change the status. Instead, it goes to admin for review, and the admin can then approve or reject the false alarm claim.

---

## Changes Made

### 1. Report Service (`services/report-service/server.js`)

**What Changed:**
- ❌ **Removed**: Automatic status change to `false_alarm` when count >= 3
- ❌ **Removed**: Automatic notification sending when status changes
- ✅ **Added**: Return `needsAdminReview` flag when false_report_count >= 3

**Lines Modified**: 143-221

**New Response Format:**
```json
{
  "success": true,
  "message": "Мэдээлэл амжилттай илгээгдлээ",
  "data": {
    "report": {...},
    "falseReportCount": 3,
    "needsAdminReview": true,
    "adminMessage": "Админ шалгах шаардлагатай (3+ хуурмаг мэдээлэл)"
  }
}
```

**Key Changes:**
```javascript
// ✅ DON'T auto-change status - admin will decide
// Just return the count and whether it needs admin review
const needsAdminReview = falseReportCount >= 3;

res.status(201).json({
  success: true,
  message: 'Мэдээлэл амжилттай илгээгдлээ',
  data: {
    report,
    falseReportCount,
    needsAdminReview,
    adminMessage: needsAdminReview
      ? 'Админ шалгах шаардлагатай (3+ хуурмаг мэдээлэл)'
      : null
  }
});
```

---

### 2. Admin Service (`services/admin-service/server.js`)

**What Changed:**
- ✅ **Added**: Notification sending when admin marks accident as `false_alarm`
- ✅ **Added**: Notification service integration for false alarm notifications

**Lines Modified**: 325-399 (PUT `/admin/accidents/:id/status` endpoint)

**New Logic:**
```javascript
// ✅ If admin marks as false_alarm, send notifications to users
if (status === 'false_alarm') {
  try {
    // Get all users who were notified about this accident
    const notifiedUsersResult = await pool.query(`
      SELECT DISTINCT user_id
      FROM notifications
      WHERE accident_id = $1 AND type = 'accident_confirmed'
    `, [id]);

    const userIds = notifiedUsersResult.rows.map(row => row.user_id);

    if (userIds.length > 0) {
      const notificationServiceUrl = process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3005';
      const axios = require('axios');

      await axios.post(
        `${notificationServiceUrl}/notifications/send`,
        {
          userIds: userIds,
          accidentId: parseInt(id),
          type: 'false_alarm',
          title: '⚠️ Буруу мэдээлэл баталгаажлаа',
          message: `Осол #${id} буруу мэдээлэл гэж админ баталгаажууллаа.`,
          data: {
            latitude: String(accident.latitude),
            longitude: String(accident.longitude),
            accidentId: String(id),
            status: 'false_alarm'
          }
        },
        { timeout: 10000 }
      );

      console.log(`✅ False alarm notification sent to ${userIds.length} users by admin`);
    }
  } catch (notifyErr) {
    console.error('⚠️ Failed to send false alarm notification:', notifyErr.message);
    // Don't fail the status update if notification fails
  }
}
```

---

### 3. Admin Dashboard - Accidents Table (`public/js/accidents.js`)

**What Changed:**
- ✅ **Added**: Visual indicator (yellow badge) when `false_report_count >= 3`
- ✅ **Added**: Yellow background highlight for accidents needing review
- ✅ **Added**: "Update Status" button (warning color) for accidents with 3+ false reports
- ✅ **Added**: Status update dialog with options

**Lines Modified**: 61-81, 91-123, 155-161

**Visual Changes:**
1. **Yellow Badge**: Shows false report count next to status badge
   ```html
   <span class="badge badge-warning" title="3 хэрэглэгч хуурмаг гэж мэдээлсэн">
     <i class="fas fa-exclamation-triangle"></i> 3
   </span>
   ```

2. **Yellow Row Background**: Highlights rows needing admin review
   ```html
   <tr style="background-color: #fff3cd;">
   ```

3. **Update Button**: Warning-colored button appears when needs review
   ```html
   <button class="btn btn-sm btn-warning"
           onclick="showStatusUpdateDialog(1, 3)"
           title="Төлөв шинэчлэх (3 хуурмаг мэдээлэл)">
     <i class="fas fa-edit"></i>
   </button>
   ```

**New Functions Added:**

1. `showStatusUpdateDialog(id, falseReportCount)` - Shows admin decision dialog
   ```javascript
   function showStatusUpdateDialog(id, falseReportCount) {
     const message = `Осол #${id} - ${falseReportCount} хэрэглэгч хуурмаг мэдээлэл гэж мэдээлсэн.

     Админ төлөв шинэчлэх:

     1. Хуурмаг мэдээлэл (False Alarm) - Хэрэглэгчдэд мэдэгдэл илгээнэ
     2. Баталгаажсан (Confirmed) - Осол үнэхээр болсон
     3. Цуцлах

     Та ямар төлөвт шилжүүлэх вэ?`;

     const choice = prompt(message + '\n\nОруулна уу: 1=Хуурмаг, 2=Баталгаажсан, 3=Цуцлах', '');

     if (choice === '1') {
       updateAccidentStatusWithConfirm(id, 'false_alarm', 'Хуурмаг мэдээлэл гэж тэмдэглэх үү? Хэрэглэгчдэд мэдэгдэл илгээгдэнэ.');
     } else if (choice === '2') {
       updateAccidentStatusWithConfirm(id, 'confirmed', 'Баталгаажсан гэж тэмдэглэх үү?');
     }
   }
   ```

2. `updateAccidentStatusWithConfirm(id, newStatus, confirmMessage)` - Updates status with confirmation
   ```javascript
   async function updateAccidentStatusWithConfirm(id, newStatus, confirmMessage) {
     if (!confirm(confirmMessage)) return;

     const result = await api.updateAccidentStatus(id, newStatus);
     if (result.success) {
       if (newStatus === 'false_alarm') {
         showToast('Төлөв шинэчлэгдлээ. Хэрэглэгчдэд мэдэгдэл илгээгдлээ.', 'success');
       } else {
         showToast('Төлөв шинэчлэгдлээ', 'success');
       }
       await loadAccidents();
     }
   }
   ```

---

## Complete Workflow

### Step 1: Users Report False Accident
1. User opens accident in mobile app
2. User clicks "Хуурмаг мэдээлэл" (False Report) button
3. App sends request to `report-service`
4. Report service adds record to `false_reports` table
5. Returns response with `falseReportCount` and `needsAdminReview` flag

### Step 2: Admin Sees Flagged Accident
1. Admin opens Accidents page in admin dashboard
2. Accidents with `false_report_count >= 3` are:
   - Highlighted with yellow background
   - Show warning badge with count
   - Display "Update Status" button (yellow/warning color)

### Step 3: Admin Reviews and Decides
1. Admin clicks "Update Status" button
2. Dialog shows:
   - Number of users who reported it as false
   - Options: False Alarm / Confirmed / Cancel
3. Admin selects option:
   - **Option 1 (False Alarm)**:
     - Status changes to `false_alarm`
     - Notification service sends notifications to all users who were notified about the accident
     - Toast message: "Төлөв шинэчлэгдлээ. Хэрэглэгчдэд мэдэгдэл илгээгдлээ."
   - **Option 2 (Confirmed)**:
     - Status stays/changes to `confirmed`
     - No notifications sent
     - Toast message: "Төлөв шинэчлэгдлээ"
   - **Option 3 (Cancel)**:
     - No changes made

### Step 4: Users Receive Notification (if False Alarm)
1. Notification service receives request from admin service
2. Sends push notifications to all affected users
3. Notification contains:
   - Title: "⚠️ Буруу мэдээлэл баталгаажлаа"
   - Message: "Осол #X буруу мэдээлэл гэж админ баталгаажууллаа."
   - Data: accident location, ID, new status

---

## Database Schema (No Changes Required)

The existing `false_reports` table already has the UNIQUE constraint:
```sql
CREATE TABLE false_reports (
  id SERIAL PRIMARY KEY,
  accident_id INTEGER REFERENCES accidents(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason_id INTEGER REFERENCES report_reasons(id),
  comment TEXT,
  reported_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT unique_user_accident_report UNIQUE (user_id, accident_id)
);
```

The `accidents` table query already includes `false_report_count` via COUNT:
```sql
SELECT a.*, COUNT(DISTINCT fr.id) as false_report_count
FROM accidents a
LEFT JOIN false_reports fr ON a.id = fr.accident_id
GROUP BY a.id
```

---

## API Endpoints

### 1. Report False Accident (No change to endpoint, only response format)
```
POST /reports/false
Authorization: Bearer <token>

Request Body:
{
  "accidentId": 1,
  "reasonId": 1,
  "comment": "This is not an accident"
}

Response (NEW FORMAT):
{
  "success": true,
  "message": "Мэдээлэл амжилттай илгээгдлээ",
  "data": {
    "report": {...},
    "falseReportCount": 3,
    "needsAdminReview": true,
    "adminMessage": "Админ шалгах шаардлагатай (3+ хуурмаг мэдээлэл)"
  }
}
```

### 2. Update Accident Status (Enhanced with notifications)
```
PUT /admin/accidents/:id/status
Authorization: Bearer <admin_token>

Request Body:
{
  "status": "false_alarm"
}

Response:
{
  "success": true,
  "message": "Төлөв шинэчлэгдлээ",
  "data": {
    "id": 1,
    "status": "false_alarm",
    ...
  }
}

Side Effect (if status = false_alarm):
- Sends notification to all users via notification service
```

---

## Testing Steps

### Test 1: User Reports False Accident
1. Open mobile app as User 1
2. Report accident #1 as false
3. Open mobile app as User 2
4. Report same accident #1 as false
5. Open mobile app as User 3
6. Report same accident #1 as false
7. **Expected**: Response shows `needsAdminReview: true`

### Test 2: Admin Sees Flagged Accident
1. Open admin dashboard → Accidents page
2. **Expected**: Accident #1 shows:
   - Yellow background
   - Badge showing "⚠️ 3"
   - Yellow "Update Status" button

### Test 3: Admin Approves False Alarm
1. Click "Update Status" button on accident #1
2. Enter "1" (False Alarm)
3. Confirm
4. **Expected**:
   - Status changes to `false_alarm`
   - Toast shows "Төлөв шинэчлэгдлээ. Хэрэглэгчдэд мэдэгдэл илгээгдлээ."
   - All 3 users receive push notification

### Test 4: Admin Keeps as Confirmed
1. Have another accident with 3+ false reports
2. Click "Update Status" button
3. Enter "2" (Confirmed)
4. Confirm
5. **Expected**:
   - Status stays `confirmed`
   - No notifications sent
   - Toast shows "Төлөв шинэчлэгдлээ"

---

## Environment Variables

Make sure these are set in admin service:

```env
NOTIFICATION_SERVICE_URL=http://localhost:3005
```

---

## Files Modified

1. ✅ `services/report-service/server.js` - Lines 143-221
2. ✅ `services/admin-service/server.js` - Lines 325-399
3. ✅ `services/admin-service/public/js/accidents.js` - Lines 61-81, 91-123, 155-161

---

## Date Applied
November 18, 2025

## Status
✅ All changes complete and ready for testing
