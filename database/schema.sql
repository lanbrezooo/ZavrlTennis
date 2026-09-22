CREATE DATABASE IF NOT EXISTS zavrl_tennis CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE zavrl_tennis;

CREATE TABLE IF NOT EXISTS uporabniki (
  id INT AUTO_INCREMENT PRIMARY KEY,
  ime VARCHAR(50) NOT NULL,
  priimek VARCHAR(50) NOT NULL,
  email VARCHAR(100) NOT NULL UNIQUE,
  geslo_hash VARCHAR(255) NOT NULL,
  telefon VARCHAR(30) NULL,
  leto_rojstva INT NULL,
  opis TEXT NULL,
  nivo VARCHAR(50) DEFAULT 'Rekreativec',
  letna_karta BOOLEAN NOT NULL DEFAULT FALSE,
  krediti INT NOT NULL DEFAULT 0,
  admin BOOLEAN NOT NULL DEFAULT FALSE,
  prikazi_telefon BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS nastavitve (
  kljuc VARCHAR(50) PRIMARY KEY,
  vrednost VARCHAR(255) NOT NULL
) ENGINE=InnoDB;

INSERT INTO nastavitve (kljuc, vrednost) VALUES
('sezona', 'poletje'),
('zapiralna_ura', '22')
ON DUPLICATE KEY UPDATE vrednost = VALUES(vrednost);

CREATE TABLE IF NOT EXISTS rezervacije (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  igrisce INT NOT NULL,
  datum DATE NOT NULL,
  ura_zacetka INT NOT NULL,
  trajanje INT NOT NULL DEFAULT 1,
  krediti_porabili INT NOT NULL DEFAULT 0,
  letna_karta_uporabljena BOOLEAN NOT NULL DEFAULT FALSE,
  oznaka VARCHAR(100) DEFAULT NULL,
  blokada BOOLEAN NOT NULL DEFAULT FALSE,
  preklicano BOOLEAN NOT NULL DEFAULT FALSE,
  datum_preklica DATETIME DEFAULT NULL,
  placilo_z_kartico BOOLEAN NOT NULL DEFAULT FALSE,
  stripe_session_id VARCHAR(255) DEFAULT NULL,
  placilo_status ENUM('neplacano','pending','placano','preklicano') NOT NULL DEFAULT 'neplacano',
  hold_expires_at DATETIME DEFAULT NULL,
  stripe_refund_id VARCHAR(255) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES uporabniki(id) ON DELETE CASCADE,
  UNIQUE KEY uq_rezervacije_stripe_session_id (stripe_session_id),
  INDEX idx_reservations_date (datum),
  INDEX idx_reservations_user (user_id),
  CONSTRAINT chk_igrisce CHECK (igrisce BETWEEN 1 AND 9),
  CONSTRAINT chk_ura CHECK (ura_zacetka BETWEEN 8 AND 21),
  CONSTRAINT chk_trajanje CHECK (trajanje BETWEEN 1 AND 14)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS novice (
  id INT AUTO_INCREMENT PRIMARY KEY,
  naslov VARCHAR(255) NOT NULL,
  vsebina TEXT,
  datum TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  slika_url LONGTEXT DEFAULT NULL,
  slike JSON DEFAULT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS minimax_stranke (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  minimax_customer_id VARCHAR(100) NOT NULL,
  email VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_minimax_stranke_user (user_id),
  UNIQUE KEY uq_minimax_stranke_email (email),
  FOREIGN KEY (user_id) REFERENCES uporabniki(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS minimax_racuni (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  minimax_invoice_id VARCHAR(100) DEFAULT NULL,
  stripe_session_id VARCHAR(255) NOT NULL,
  znesek DECIMAL(10,2) NOT NULL,
  tip ENUM('krediti','rezervacija') NOT NULL,
  status ENUM('pending','izdan','napaka') NOT NULL DEFAULT 'pending',
  napaka TEXT DEFAULT NULL,
  krediti_dodani TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_minimax_racuni_stripe_session_id (stripe_session_id),
  FOREIGN KEY (user_id) REFERENCES uporabniki(id) ON DELETE CASCADE
) ENGINE=InnoDB;