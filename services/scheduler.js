const cron = require('node-cron');
// const { runAllOrders } = require('./orderSubmitter');

function initScheduler() {
  console.log('ℹ️  Автоматското испраќање нарачки по распоред е ИСКЛУЧЕНО.');
  console.log('   Нарачките се праќаат рачно преку копчето „Прати нарачка за утре" во апликацијата.');

  // Scheduled cron jobs are disabled — orders are now sent manually by each driver.
  //
  // To re-enable, uncomment the block below:
  //
  // const scheduleTimes = ['0 12 * * *', '0 13 * * *', '0 14 * * *', '50 14 * * *'];
  // scheduleTimes.forEach(time => {
  //   cron.schedule(time, async () => {
  //     console.log(`[${new Date().toLocaleString()}] Извршување на автоматско испраќање (Cron: ${time})`);
  //     try {
  //       await runAllOrders();
  //     } catch (err) {
  //       console.error('Грешка при автоматско испраќање:', err);
  //     }
  //   });
  // });
  // console.log('✅ Распоредувачот е активен.');
}

module.exports = { initScheduler };
