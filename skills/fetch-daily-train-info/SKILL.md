---
name: fetch-daily-train-info
description: Use when you need to get the daily train information from the 12306 train info repository
---

# Fetch Daily Train Info

## Overview

Get the latest daily train information by fetching it from GitHub Release using curl. The train info is updated daily and stored as a markdown file in the releases.

## When to Use

- Need to get train information for a specific date
- Need historical train data for a specific date
- Need to update local train info cache

**Important:** You MUST ask the user for the specific date they want (YYYYMMDD format) if they haven't provided one. Don't assume a date automatically.

## URL Pattern

The GitHub Release URL follows the pattern:
```
https://github.com/HerbertHe/cr-12306-train-info/releases/download/data-<YYYYMMDD>/train_detail_<YYYYMMDD>.md
```

**Note:** The release date is often for the next day. For example, `data-20260414` contains `train_detail_20260413.md`.

## Implementation

### Fetch with curl

```bash
# For a specific date (YYYYMMDD format)
DATE=20260413
curl -f "https://github.com/HerbertHe/cr-12306-train-info/releases/download/data-${DATE}/train_detail_${DATE}.md" -o train_detail_${DATE}.md
```

## Check Download Result

After downloading, always check if the file is empty:

```bash
# Check if file exists and is not empty
if [ ! -s "train_detail_${DATE}.md" ]; then
  echo "Error: Failed to download train data for date ${DATE}. The file is empty or does not exist."
  exit 1
fi
```

## Example Usage

### Get train info for a specific date

```bash
# Specify date manually (YYYYMMDD format)
DATE=20260413
curl -f "https://github.com/HerbertHe/cr-12306-train-info/releases/download/data-${DATE}/train_detail_${DATE}.md"

# Check if download succeeded and file is not empty
if [ ! -s "train_detail_${DATE}.md" ]; then
  echo "Error: Failed to download train data for date ${DATE}. The file is empty or does not exist."
  exit 1
fi
```

### Save to file with check

```bash
DATE=20260413
curl -f "https://github.com/HerbertHe/cr-12306-train-info/releases/download/data-${DATE}/train_detail_${DATE}.md" -o train_detail_${DATE}.md

# Exit if download failed or file is empty
if [ ! -s "train_detail_${DATE}.md" ]; then
  echo "Error: Failed to download train data for date ${DATE}. The file is empty or does not exist."
  exit 1
fi
```

## Common Mistakes

- Using the wrong date format (must be YYYYMMDD)
- Mismatching the date in the release path and file name
- Expecting today's data to exist before the day ends

## After Fetching

After successfully fetching the data:

1. **Count total trains**: Count the total number of trains in the downloaded file (count table rows)
2. **Inform customer**: Tell the customer the total number of trains obtained
3. **Ask for train type**: Ask the user which train type they want:

Available options:

- **全部**: All trains (show everything)
- **高速**: Only high-speed trains (G - high-speed rail, C - intercity, D - EMU)
- **普通**: Only conventional trains (S - suburban railway, K - express, T - express, Y - tourist, Z - direct express)

Wait for the user's selection before filtering and displaying the results.

## Filtering with Python

### Markdown Table Structure

The fetched markdown file has the following structure:

| 序号 | 车号(train_no) | 站点车次(station_train_code) | 站点(到站时间 - 发车时间 - 运行时间 - 到达日) | 站点数量(total_num) |

### Filtering Script

Use this Python script to filter by train type and optionally by station keyword based on the first character of the train number and station name:

```python
import re
import sys

def filter_trains(input_file, train_type, station_keyword=None):
    # Define patterns based on train type
    patterns = {
        '高速': r'^[GCD]',
        '普通': r'^[SKTYZ]',
        '全部': r'.*'
    }
    
    train_pattern = patterns.get(train_type, r'.*')
    
    with open(input_file, 'r', encoding='utf-8') as f:
        lines = f.readlines()
    
    # Keep header and separator (markdown file has title + table header)
    result = lines[:4]
    
    # Filter lines matching the pattern
    for line in lines[4:]:
        # Extract the first character of the visible train number
        # The actual data stores a hash in the second column, visible number is in third column
        visible_match = re.search(r'\|\s*\d+\s*\|\s*.*\|\s*([A-Za-z])', line)
        if not visible_match:
            continue
        
        first_char = visible_match.group(1)
        if not re.match(train_pattern, first_char):
            continue
        
        # If station keyword provided, check if it exists in the station column
        if station_keyword:
            # Extract the station column (fourth column)
            parts = line.split('|')
            if len(parts) >= 5:
                station_info = parts[4].strip()
                if station_keyword not in station_info:
                    continue
        
        result.append(line)
    
    # Print the result
    print(''.join(result))
    print(f"\n---")
    print(f"Total trains: {len(result) - 4}")

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python filter_trains.py <input_file> <train_type> [station_keyword]")
        print("train_type: 全部, 高速, 普通")
        print("station_keyword: optional keyword to filter stations (e.g., 南京)")
        sys.exit(1)
    
    station_keyword = sys.argv[3] if len(sys.argv) >= 4 else None
    filter_trains(sys.argv[1], sys.argv[2], station_keyword)
```

### Usage

```bash
# Filter by train type only
python filter_trains.py train_detail_YYYYMMDD.md 高速

# Filter by train type and station keyword (matches any station containing the keyword)
python filter_trains.py train_detail_YYYYMMDD.md 高速 南京
```

### How Station Filtering Works

- If user provides a station name (e.g. "南京"), filters to show **only trains that have the keyword in any of their stations**
- This matches "南京站", "南京南站", "南京东站", etc. 
- Uses simple substring matching, not exact match

## Notes

- Data is updated daily by the repository maintainer
- The release tag is `data-YYYYMMDD` for the next day's release containing the previous day's data
- File is in markdown format with train details
