const cron = require('node-cron');
const { runAllOrders } = require('./orderSubmitter');

function initScheduler() {
  console.log('Покренување на распоредувачот за автоматско испраќање нарачки...');
  
  // Schedule at 12:00, 13:00, 14:00, 14:50 daily
  const scheduleTimes = ['0 12 * * *', '0 13 * * *', '0 14 * * *', '50 14 * * *'];
  
  scheduleTimes.forEach(time => {
    cron.schedule(time, async () => {
      console.log(`[${new Date().toLocaleString()}] Извршување на автоматско испраќање (Cron: ${time})`);
      try {
        await runAllOrders();
      } catch (err) {
        console.error('Грешка при автоматско испраќање:', err);
      }
    });
  });
  
  console.log('✅ Распоредувачот е активен.');
}

module.exports = { initScheduler };
