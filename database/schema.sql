-- Ustvari bazo (prilagodite ime, če želite)
CREATE DATABASE IF NOT EXISTS zavrl_tennis CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE zavrl_tennis; 

-- Tabela uporabnikov
CREATE TABLE IF NOT EXISTS uporabniki (
    id INT AUTO_INCREMENT PRIMARY KEY,
    ime VARCHAR(50) NOT NULL,
    priimek VARCHAR(50) NOT NULL,
    email VARCHAR(100) NOT NULL UNIQUE,
    geslo_hash VARCHAR(255) NOT NULL,
    leto_rojstva INT,
    opis TEXT,
    nivo VARCHAR(50) DEFAULT 'Rekreativec',
    letna_karta BOOLEAN DEFAULT FALSE,
    krediti INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Tabela rezervacij
CREATE TABLE IF NOT EXISTS rezervacije (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    igrisce INT NOT NULL,
    datum DATE NOT NULL,
    ura_zacetka INT NOT NULL,
    trajanje INT NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES uporabniki(id) ON DELETE CASCADE,
    UNIQUE KEY unique_termin (igrisce, datum, ura_zacetka),
    CONSTRAINT chk_igrisce CHECK (igrisce BETWEEN 1 AND 8),
    CONSTRAINT chk_ura CHECK (ura_zacetka BETWEEN 8 AND 21),
    CONSTRAINT chk_trajanje CHECK (trajanje BETWEEN 1 AND 3)
) ENGINE=InnoDB;