CREATE TABLE post_offices (
    index_code TEXT PRIMARY KEY,  
    address TEXT NOT NULL,
    phone TEXT NOT NULL,
    is_active BOOLEAN DEFAULT 1, 
    closed_at TIMESTAMP,          
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
CREATE TABLE shipments (
    tracking_number TEXT PRIMARY KEY,
    sender_name TEXT DEFAULT '',
    sender_phone TEXT,
    sender_address TEXT,
    recipient_name TEXT NOT NULL,
    recipient_phone TEXT,
    recipient_address TEXT NOT NULL,
    weight_kg DECIMAL(10, 3) NOT NULL CHECK (weight_kg > 0),
    type TEXT NOT NULL CHECK (type IN ('letter', 'parcel', 'package', 'document', 'express')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
CREATE TABLE statuses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tracking_number TEXT NOT NULL,
    status TEXT NOT NULL,
    location_index TEXT NOT NULL,
    status_date TIMESTAMP NOT NULL,
    notes TEXT,
    FOREIGN KEY (tracking_number) REFERENCES shipments(tracking_number)
)
CREATE TABLE tracking_counter (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_number INTEGER NOT NULL DEFAULT 0
)
