
// Haversine formula to calculate distance between two coordinates in meters
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth's radius in meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// Test cases
const testCases = [
    {
        name: "Same location",
        lat1: 47.9188, lon1: 106.9176,
        lat2: 47.9188, lon2: 106.9176,
        expected: 0
    },
    {
        name: "Very close (approx 10m)",
        lat1: 47.9188, lon1: 106.9176,
        lat2: 47.91889, lon2: 106.9176,
        expected: 10 // approx
    },
    {
        name: "Within 200m radius (approx 150m)",
        lat1: 47.9188, lon1: 106.9176,
        lat2: 47.92015, lon2: 106.9176,
        expected: 150 // approx
    },
    {
        name: "Outside 200m radius (approx 250m)",
        lat1: 47.9188, lon1: 106.9176,
        lat2: 47.92105, lon2: 106.9176,
        expected: 250 // approx
    }
];

console.log("Running Distance Calculation Tests...");
testCases.forEach(test => {
    const distance = calculateDistance(test.lat1, test.lon1, test.lat2, test.lon2);
    console.log(`Test: ${test.name}`);
    console.log(`  Distance: ${distance.toFixed(2)} meters`);

    if (test.name.includes("Within 200m") && distance <= 200) {
        console.log("  ✅ PASS: Correctly within 200m");
    } else if (test.name.includes("Outside 200m") && distance > 200) {
        console.log("  ✅ PASS: Correctly outside 200m");
    } else if (test.expected === 0 && distance < 0.1) {
        console.log("  ✅ PASS: Zero distance");
    } else if (test.name.includes("Very close")) {
        console.log("  ℹ️ Info: Close distance check");
    }
    console.log("---");
});
