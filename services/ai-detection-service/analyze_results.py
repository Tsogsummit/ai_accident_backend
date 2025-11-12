"""
Analyze Detection Results - Generate statistics and charts from batch test
"""

import json
import sys
import os
from collections import Counter

def analyze_results(json_path):
    """
    Analyze detection results from batch test
    
    Args:
        json_path: Path to detection_results.json
    """
    print("=" * 70)
    print("📊 DETECTION RESULTS ANALYZER")
    print("=" * 70)
    
    # Load results
    if not os.path.exists(json_path):
        print(f"❌ File not found: {json_path}")
        return False
    
    with open(json_path, 'r') as f:
        results = json.load(f)
    
    if not results:
        print("❌ No results in file")
        return False
    
    print(f"\n📁 Analyzing: {json_path}")
    print(f"📸 Total images: {len(results)}")
    
    # Calculate statistics
    total_vehicles = sum(r['total_vehicles'] for r in results)
    total_objects = sum(r['total_objects'] for r in results)
    
    # Vehicle types
    all_vehicle_types = []
    for r in results:
        for v in r['vehicles']:
            all_vehicle_types.append(v['class'])
    
    vehicle_counts = Counter(all_vehicle_types)
    
    # Confidence scores
    all_confidences = []
    for r in results:
        for v in r['vehicles']:
            all_confidences.append(v['confidence'])
    
    # Images by vehicle count
    images_by_vehicles = sorted(results, key=lambda x: x['total_vehicles'], reverse=True)
    images_no_vehicles = [r for r in results if r['total_vehicles'] == 0]
    images_with_vehicles = [r for r in results if r['total_vehicles'] > 0]
    
    # Print detailed statistics
    print("\n" + "=" * 70)
    print("📈 DETAILED STATISTICS")
    print("=" * 70)
    
    print(f"\n🔍 Detection Overview:")
    print(f"   Total objects detected: {total_objects}")
    print(f"   Total vehicles detected: {total_vehicles}")
    print(f"   Images with vehicles: {len(images_with_vehicles)} ({len(images_with_vehicles)/len(results)*100:.1f}%)")
    print(f"   Images without vehicles: {len(images_no_vehicles)} ({len(images_no_vehicles)/len(results)*100:.1f}%)")
    
    if total_vehicles > 0:
        avg_vehicles = total_vehicles / len(results)
        avg_vehicles_with = total_vehicles / len(images_with_vehicles) if images_with_vehicles else 0
        
        print(f"\n📊 Vehicle Statistics:")
        print(f"   Average vehicles per image (all): {avg_vehicles:.2f}")
        print(f"   Average vehicles per image (with vehicles): {avg_vehicles_with:.2f}")
        print(f"   Min vehicles: {min(r['total_vehicles'] for r in results)}")
        print(f"   Max vehicles: {max(r['total_vehicles'] for r in results)}")
    
    if vehicle_counts:
        print(f"\n🚙 Vehicle Type Distribution:")
        for vtype, count in vehicle_counts.most_common():
            percentage = (count / total_vehicles) * 100
            bar_length = int(percentage / 2)
            bar = "█" * bar_length
            print(f"   {vtype:12} {count:4} ({percentage:5.1f}%) {bar}")
    
    if all_confidences:
        avg_confidence = sum(all_confidences) / len(all_confidences)
        min_confidence = min(all_confidences)
        max_confidence = max(all_confidences)
        
        print(f"\n🎯 Confidence Scores:")
        print(f"   Average: {avg_confidence:.2%}")
        print(f"   Min: {min_confidence:.2%}")
        print(f"   Max: {max_confidence:.2%}")
        
        # Confidence distribution
        high_conf = sum(1 for c in all_confidences if c >= 0.8)
        med_conf = sum(1 for c in all_confidences if 0.5 <= c < 0.8)
        low_conf = sum(1 for c in all_confidences if c < 0.5)
        
        print(f"\n   Distribution:")
        print(f"   High (≥80%): {high_conf} ({high_conf/len(all_confidences)*100:.1f}%)")
        print(f"   Medium (50-80%): {med_conf} ({med_conf/len(all_confidences)*100:.1f}%)")
        print(f"   Low (<50%): {low_conf} ({low_conf/len(all_confidences)*100:.1f}%)")
    
    # Top images
    print(f"\n🏆 Top 10 Images (by vehicle count):")
    for i, img in enumerate(images_by_vehicles[:10], 1):
        print(f"   {i:2}. {img['filename']:30} {img['total_vehicles']:3} vehicles")
    
    # Images without vehicles
    if images_no_vehicles:
        print(f"\n⚠️  Images with NO vehicles detected ({len(images_no_vehicles)}):")
        for img in images_no_vehicles[:10]:
            print(f"   - {img['filename']}")
        if len(images_no_vehicles) > 10:
            print(f"   ... and {len(images_no_vehicles) - 10} more")
    
    # Resolution analysis
    print(f"\n📐 Image Resolutions:")
    resolutions = Counter([f"{r['width']}x{r['height']}" for r in results])
    for res, count in resolutions.most_common(5):
        print(f"   {res}: {count} images")
    
    # Generate summary report
    report_path = json_path.replace('.json', '_analysis.txt')
    with open(report_path, 'w') as f:
        f.write("DETECTION RESULTS ANALYSIS REPORT\n")
        f.write("=" * 70 + "\n\n")
        f.write(f"Total Images: {len(results)}\n")
        f.write(f"Total Vehicles: {total_vehicles}\n")
        f.write(f"Total Objects: {total_objects}\n")
        f.write(f"Average Vehicles/Image: {avg_vehicles:.2f}\n\n")
        
        f.write("Vehicle Type Distribution:\n")
        for vtype, count in vehicle_counts.most_common():
            percentage = (count / total_vehicles) * 100
            f.write(f"  {vtype}: {count} ({percentage:.1f}%)\n")
        
        f.write(f"\nTop 10 Images:\n")
        for i, img in enumerate(images_by_vehicles[:10], 1):
            f.write(f"  {i}. {img['filename']}: {img['total_vehicles']} vehicles\n")
        
        if images_no_vehicles:
            f.write(f"\nImages without vehicles ({len(images_no_vehicles)}):\n")
            for img in images_no_vehicles:
                f.write(f"  - {img['filename']}\n")
    
    print(f"\n💾 Analysis report saved to: {report_path}")
    
    print("\n" + "=" * 70)
    
    return True


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 analyze_results.py <detection_results.json>")
        print("\nExample:")
        print("  python3 analyze_results.py ./test_images/detected_output/detection_results.json")
        print("\nThis script analyzes the JSON output from test_folder.py")
        sys.exit(1)
    
    json_path = sys.argv[1]
    
    try:
        analyze_results(json_path)
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()