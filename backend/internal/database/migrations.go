package database

const migrationsSQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
    key_name VARCHAR(64) PRIMARY KEY,
    value_text TEXT NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS accounts (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    provider VARCHAR(32) NOT NULL DEFAULT 'imap',
    imap_host VARCHAR(255) NOT NULL,
    imap_port INT NOT NULL DEFAULT 993,
    imap_tls TINYINT(1) NOT NULL DEFAULT 1,
    imap_encryption VARCHAR(16) NOT NULL DEFAULT 'ssl',
    smtp_host VARCHAR(255) NOT NULL,
    smtp_port INT NOT NULL DEFAULT 587,
    smtp_tls TINYINT(1) NOT NULL DEFAULT 1,
    smtp_encryption VARCHAR(16) NOT NULL DEFAULT 'starttls',
    username VARCHAR(255) NOT NULL,
    password_encrypted TEXT,
    oauth_token TEXT,
    oauth_refresh_token TEXT,
    proxy_enabled TINYINT(1) NOT NULL DEFAULT 0,
    proxy_host VARCHAR(255) DEFAULT '',
    proxy_port INT DEFAULT 0,
    is_default TINYINT(1) NOT NULL DEFAULT 0,
    last_sync_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS folders (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    account_id BIGINT NOT NULL,
    name VARCHAR(255) NOT NULL,
    role VARCHAR(32) NOT NULL DEFAULT '',
    uid_validity BIGINT,
    uid_next BIGINT,
    last_synced_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    UNIQUE KEY uq_folder_account_name (account_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS messages (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    account_id BIGINT NOT NULL,
    folder_id BIGINT NOT NULL,
    uid BIGINT NOT NULL,
    message_id VARCHAR(512),
    subject TEXT NOT NULL,
    from_address VARCHAR(512) NOT NULL DEFAULT '',
    from_name VARCHAR(512) NOT NULL DEFAULT '',
    to_addresses TEXT NOT NULL,
    cc_addresses TEXT NOT NULL,
    bcc_addresses TEXT NOT NULL,
    reply_to VARCHAR(512),
    body_text LONGTEXT,
    body_html LONGTEXT,
    snippet VARCHAR(1024) DEFAULT '',
    received_at DATETIME,
    sent_at DATETIME,
    size BIGINT DEFAULT 0,
    is_read TINYINT(1) NOT NULL DEFAULT 0,
    is_starred TINYINT(1) NOT NULL DEFAULT 0,
    is_answered TINYINT(1) NOT NULL DEFAULT 0,
    is_forwarded TINYINT(1) NOT NULL DEFAULT 0,
    is_draft TINYINT(1) NOT NULL DEFAULT 0,
    is_deleted TINYINT(1) NOT NULL DEFAULT 0,
    has_attachments TINYINT(1) NOT NULL DEFAULT 0,
    labels TEXT NOT NULL,
    thread_id VARCHAR(512),
    in_reply_to VARCHAR(512),
    ref_references TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
    UNIQUE KEY uq_msg_account_folder_uid (account_id, folder_id, uid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS attachments (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    message_id BIGINT NOT NULL,
    filename VARCHAR(512) NOT NULL,
    mime_type VARCHAR(255) NOT NULL,
    size BIGINT NOT NULL DEFAULT 0,
    content_id VARCHAR(512),
    part_id VARCHAR(255),
    content LONGBLOB,
    content_expires_at DATETIME,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS kanban_items (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    message_id BIGINT,
    title VARCHAR(512) NOT NULL,
    description TEXT,
    status VARCHAR(32) NOT NULL DEFAULT 'todo',
    position INT NOT NULL DEFAULT 0,
    due_date DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS snoozed_items (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    message_id BIGINT NOT NULL,
    snoozed_until DATETIME NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS settings (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    setting_key VARCHAR(128) NOT NULL UNIQUE,
    setting_value MEDIUMTEXT NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS drafts (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    account_id BIGINT,
    to_addresses TEXT NOT NULL,
    cc_addresses TEXT NOT NULL,
    bcc_addresses TEXT NOT NULL,
    subject TEXT NOT NULL,
    body_html LONGTEXT,
    body_text LONGTEXT,
    in_reply_to VARCHAR(512),
    ref_references TEXT,
    is_trashed TINYINT(1) NOT NULL DEFAULT 0,
    sync_revision BIGINT NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS draft_remote_copies (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    draft_id BIGINT,
    account_id BIGINT NOT NULL,
    mailbox VARCHAR(512) NOT NULL,
    uid BIGINT NOT NULL DEFAULT 0,
    message_id VARCHAR(512) NOT NULL,
    synced_revision BIGINT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (draft_id) REFERENCES drafts(id) ON DELETE SET NULL,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    UNIQUE KEY uq_draft_remote_copy (draft_id),
    KEY idx_draft_remote_account (account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pending_remote_ops (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    account_id BIGINT NOT NULL,
    message_id BIGINT NOT NULL,
    action VARCHAR(64) NOT NULL,
    payload TEXT NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pgp_keys (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    public_key TEXT NOT NULL,
    private_key TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('language', 'zh-CN');
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('theme', 'light');
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('notifications_enabled', 'true');
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('auto_refresh_enabled', 'true');
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('check_interval', '300');
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('ai_base_url', '');
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('ai_api_key', '');
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('ai_model', 'gpt-4o-mini');
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('ai_context_window', '0');
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('ai_target_lang', 'zh-CN');
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('ai_translate_prompt', 'You are a professional translator. Translate the following text to {target_lang}. Only return the translation, no explanations.');
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('ai_translate_enabled', 'false');
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('ai_summarize_enabled', 'false');
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('ai_translate_use_global', 'true');
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('ai_translate_base_url', '');
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('ai_translate_api_key', '');
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('ai_translate_model', '');
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('ai_system_prompt', '');
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('autosave_interval', '10');
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('auto_load_remote_resources', 'false');
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('prevent_tracking', 'true');
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('retention_messages_days', '0');
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('retention_attachments_days', '0');
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('retention_images_days', '0');
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('storage_limit_gb', '5');
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('appearance', '{"accent_color":"#006bff","sidebar_blur":0,"sidebar_opacity":100,"bg_blur":0,"border_radius":6,"font_size":"md","compact_mode":false,"shadow_intensity":"md","animation_speed":"normal"}');
`

const seedRolesSQL = `
INSERT IGNORE INTO folders (account_id, name, role)
SELECT a.id, 'INBOX', 'inbox' FROM accounts a;
INSERT IGNORE INTO folders (account_id, name, role)
SELECT a.id, 'Sent', 'sent' FROM accounts a;
INSERT IGNORE INTO folders (account_id, name, role)
SELECT a.id, 'Drafts', 'drafts' FROM accounts a;
INSERT IGNORE INTO folders (account_id, name, role)
SELECT a.id, 'Trash', 'trash' FROM accounts a;
INSERT IGNORE INTO folders (account_id, name, role)
SELECT a.id, 'Archive', 'archive' FROM accounts a;
INSERT IGNORE INTO folders (account_id, name, role)
SELECT a.id, 'Spam', 'spam' FROM accounts a;

UPDATE folders SET role = 'inbox'   WHERE role = '' AND LOWER(name) = 'inbox';
UPDATE folders SET role = 'sent'    WHERE role = '' AND LOWER(name) IN ('sent', 'sent items', 'sent messages');
UPDATE folders SET role = 'drafts'  WHERE role = '' AND LOWER(name) IN ('drafts', 'draft');
UPDATE folders SET role = 'trash'   WHERE role = '' AND LOWER(name) IN ('trash', 'deleted', 'deleted items', 'bin');
UPDATE folders SET role = 'archive' WHERE role = '' AND LOWER(name) IN ('archive', 'archives', 'all mail');
UPDATE folders SET role = 'spam'    WHERE role = '' AND LOWER(name) IN ('spam', 'junk', 'junk mail');

-- Clean up stale synced-back draft copies that ended up in non-draft folders.
-- These have synthetic message_id like <mailgo-draft-{id}-r{rev}@mailgo.local>.
DELETE FROM messages
WHERE message_id LIKE '<mailgo-draft-%@mailgo.local>'
  AND is_draft = 0;
`
