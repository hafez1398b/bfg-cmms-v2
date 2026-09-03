const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://postgres:123@localhost:5432/bfg_cmms'
});

async function createAdmin() {
    const password = bcrypt.hashSync('admin123', 10);
    await pool.query(
        `INSERT INTO users (id, username, pass_hash, name, role, unit, active) 
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['admin', 'admin', password, 'مدیر سیستم', 'admin', 'فناوری اطلاعات', true]
    );
    console.log('✅ Admin user created!');
    console.log('   Username: admin');
    console.log('   Password: admin123');
    process.exit(0);
}

createAdmin().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});