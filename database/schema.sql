CREATE DATABASE IF NOT EXISTS zavrl_tennis CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE zavrl_tennis;
CREATE TABLE IF NOT EXISTS uporabniki (
 id INT AUTO_INCREMENT PRIMARY KEY, ime VARCHAR(50) NOT NULL, priimek VARCHAR(50) NOT NULL,
 email VARCHAR(100) NOT NULL UNIQUE, geslo_hash VARCHAR(255) NOT NULL, telefon VARCHAR(30) NULL,
 leto_rojstva INT NULL, opis TEXT NULL, nivo VARCHAR(50) DEFAULT 'Rekreativec',
 letna_karta BOOLEAN NOT NULL DEFAULT FALSE, krediti INT NOT NULL DEFAULT 0, admin BOOLEAN NOT NULL DEFAULT FALSE,
 created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS rezervacije (
 id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, igrisce INT NOT NULL, datum DATE NOT NULL,
 ura_zacetka INT NOT NULL, trajanje INT NOT NULL DEFAULT 1,
 krediti_porabili INT NOT NULL DEFAULT 0, letna_karta_uporabljena BOOLEAN NOT NULL DEFAULT FALSE,
 created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY (user_id) REFERENCES uporabniki(id) ON DELETE CASCADE,
 UNIQUE KEY unique_termin (igrisce, datum, ura_zacetka),
 INDEX idx_reservations_date (datum), INDEX idx_reservations_user (user_id),
 CONSTRAINT chk_igrisce CHECK (igrisce BETWEEN 1 AND 8),
 CONSTRAINT chk_ura CHECK (ura_zacetka BETWEEN 8 AND 21),
 CONSTRAINT chk_trajanje CHECK (trajanje BETWEEN 1 AND 3)
) ENGINE=InnoDB;
