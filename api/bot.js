const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');

// Initialize Firebase with proper error handling
try {
  const serviceAccount = {
    type: "service_account",
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
  };

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('✅ Firebase initialized successfully');
  }

  const db = admin.firestore();
  const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });

  // Environment Validation
  console.log('🔧 Environment Check:');
  console.log('BOT_TOKEN:', process.env.BOT_TOKEN ? '✅ Set' : '❌ Missing');
  console.log('CHANNEL_ID:', process.env.CHANNEL_ID ? '✅ Set' : '❌ Missing');
  console.log('ADMIN_IDS:', process.env.ADMIN_IDS ? '✅ Set' : '❌ Missing');
  console.log('BOT_USERNAME:', process.env.BOT_USERNAME ? '✅ Set' : '❌ Missing');

  // ========== DATABASE FUNCTIONS ========== //
  async function getUser(userId, msg = null) {
    const userDoc = await db.collection('users').doc(userId.toString()).get();
    if (!userDoc.exists) {
      const newUser = {
        telegramId: userId,
        username: 'Anonymous',
        firstName: msg?.from?.first_name || null,
        lastName: msg?.from?.last_name || null,
        joinedAt: new Date().toISOString(),
        reputation: 0,
        dailyStreak: 0,
        lastCheckin: null,
        totalConfessions: 0,
        followers: [],
        following: [],
        achievements: [],
        bio: null,
        isActive: true,
        notifications: {
          newFollower: true,
          newComment: true,
          newConfession: true,
          directMessage: true
        },
        commentSettings: {
          allowComments: 'everyone',
          allowAnonymous: true,
          requireApproval: false
        }
      };
      await db.collection('users').doc(userId.toString()).set(newUser);
      return newUser;
    }
    
    const userData = userDoc.data();
    if (userData.isActive === undefined) {
      await updateUser(userId, { isActive: true });
      userData.isActive = true;
    }
    
    if (!userData.username) {
      await updateUser(userId, { username: 'Anonymous' });
      userData.username = 'Anonymous';
    }
    
    return userData;
  }

  async function updateUser(userId, updateData) {
    await db.collection('users').doc(userId.toString()).update(updateData);
  }

  async function getConfession(confessionId) {
    const confDoc = await db.collection('confessions').doc(confessionId).get();
    return confDoc.exists ? confDoc.data() : null;
  }

  async function createConfession(confessionData) {
    await db.collection('confessions').doc(confessionData.confessionId).set(confessionData);
  }

  async function updateConfession(confessionId, updateData) {
    await db.collection('confessions').doc(confessionId).update(updateData);
  }

  async function getComment(confessionId) {
    const commentDoc = await db.collection('comments').doc(confessionId).get();
    return commentDoc.exists ? commentDoc.data() : { comments: [], totalComments: 0 };
  }

  async function updateComment(confessionId, commentData) {
    await db.collection('comments').doc(confessionId).set(commentData);
  }

  async function getCounter(counterName) {
    const counterDoc = await db.collection('counters').doc(counterName).get();
    if (!counterDoc.exists) {
      await db.collection('counters').doc(counterName).set({ value: 1 });
      return 1;
    }
    return counterDoc.data().value;
  }

  async function incrementCounter(counterName) {
    const counterRef = db.collection('counters').doc(counterName);
    const result = await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(counterRef);
      const newValue = doc.exists ? doc.data().value + 1 : 1;
      transaction.update(counterRef, { value: newValue });
      return newValue;
    });
    return result;
  }

  // ========== STATE MANAGEMENT ========== //
  async function getUserState(userId) {
    const stateDoc = await db.collection('user_states').doc(userId.toString()).get();
    return stateDoc.exists ? stateDoc.data() : null;
  }

  async function setUserState(userId, stateData) {
    await db.collection('user_states').doc(userId.toString()).set(stateData);
  }

  async function clearUserState(userId) {
    await db.collection('user_states').doc(userId.toString()).delete();
  }

  // ========== UTILITY FUNCTIONS ========== //
  function sanitizeInput(text) {
    if (!text) return '';
    
    let sanitized = text
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/javascript:/gi, '')
      .replace(/on\w+="[^"]*"/gi, '')
      .replace(/<[^>]*>/g, '')
      .trim();
    
    return sanitized;
  }

  function extractHashtags(text) {
    const hashtagRegex = /#[a-zA-Z0-9_]+/g;
    return text.match(hashtagRegex) || [];
  }

  function isAdmin(userId) {
    const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(Number) : [];
    return ADMIN_IDS.includes(userId);
  }

  function getUserLevel(commentCount) {
    if (commentCount >= 1000) return { level: 7, symbol: '👑', name: 'Level 7' };
    if (commentCount >= 500) return { level: 6, symbol: '🏅', name: 'Level 6' };
    if (commentCount >= 200) return { level: 5, symbol: '🥇', name: 'Level 5' };
    if (commentCount >= 100) return { level: 4, symbol: '🥈', name: 'Level 4' };
    if (commentCount >= 50) return { level: 3, symbol: '🥉', name: 'Level 3' };
    if (commentCount >= 25) return { level: 2, symbol: '🥈', name: 'Level 2' };
    return { level: 1, symbol: '🥉', name: 'Level 1' };
  }

  async function getCommentCount(userId) {
    let count = 0;
    try {
      const commentsSnapshot = await db.collection('comments').get();
      
      commentsSnapshot.forEach(doc => {
        const data = doc.data();
        if (data.comments && Array.isArray(data.comments)) {
          for (const comment of data.comments) {
            if (comment.userId === userId) {
              count++;
            }
          }
        }
      });
    } catch (error) {
      console.error('Comment count error:', error);
    }
    
    return count;
  }

  // ========== COOLDOWN SYSTEM ========== //
  async function checkCooldown(userId, action = 'confession', cooldownMs = 60000) {
    const cooldownDoc = await db.collection('cooldowns').doc(userId.toString()).get();
    if (!cooldownDoc.exists) return true;
    
    const data = cooldownDoc.data();
    const lastAction = data[action];
    
    if (!lastAction) return true;
    
    return (Date.now() - lastAction) > cooldownMs;
  }

  async function setCooldown(userId, action = 'confession') {
    await db.collection('cooldowns').doc(userId.toString()).set({
      [action]: Date.now()
    }, { merge: true });
  }

  // ========== NOTIFICATION SYSTEM ========== //
  async function sendNotification(userId, message, settingName) {
    try {
      const user = await getUser(userId);
      const notifications = user.notifications || {};
      
      if (notifications[settingName] !== false) {
        await bot.sendMessage(userId, message, { parse_mode: 'Markdown' });
      }
    } catch (error) {
      console.error('Notification error:', error);
    }
  }

  async function notifyUser(userId, confessionNumber, status, reason = '') {
    try {
      const statusMessages = {
        'approved': `✅ Your confession #${confessionNumber} has been approved and posted!`,
        'rejected': `❌ Your confession #${confessionNumber} was rejected.${reason ? ` Reason: ${reason}` : ''}`
      };
      
      if (statusMessages[status]) {
        await bot.sendMessage(userId, statusMessages[status]);
      }
    } catch (error) {
      console.error('Notify user error:', error);
    }
  }

  // ========== MAIN MENU ========== //
  const showMainMenu = async (chatId) => {
    const user = await getUser(chatId);
    const reputation = user.reputation || 0;
    const streak = user.dailyStreak || 0;
    const commentCount = await getCommentCount(chatId);
    const levelInfo = getUserLevel(commentCount);

    const options = {
      reply_markup: {
        keyboard: [
          [{ text: '📝 Send Confession' }, { text: '👤 My Profile' }],
          [{ text: '🔥 Trending' }, { text: '📢 Promote Bot' }],
          [{ text: '🏷️ Hashtags' }, { text: '🏆 Best Commenters' }],
          [{ text: '⚙️ Settings' }, { text: 'ℹ️ About Us' }],
          [{ text: '🔍 Browse Users' }, { text: '📌 Rules' }]
        ],
        resize_keyboard: true
      }
    };

    await bot.sendMessage(chatId,
      `🤫 *JU Confession Bot*\n\n` +
      `👤 Profile: ${user.username || 'Not set'}\n` +
      `⭐ Reputation: ${reputation}\n` +
      `🔥 Streak: ${streak} days\n` +
      `🏆 Level: ${levelInfo.symbol} ${levelInfo.name} (${commentCount} comments)\n\n` +
      `Choose an option below:`,
      { parse_mode: 'Markdown', ...options }
    );
  };

  // ========== START COMMAND ========== //
  const handleStart = async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const args = msg.text.split(' ')[1];

    console.log(`🔗 Start command with args: ${args}`);

    // Handle comment redirection from channel
    if (args && args.startsWith('comment_')) {
      const confessionId = args.replace('comment_', '');
      console.log(`📝 Redirecting to comments for: ${confessionId}`);
      
      const confession = await getConfession(confessionId);
      if (!confession) {
        await bot.sendMessage(chatId, '❌ Confession not found or may have been deleted.');
        await showMainMenu(chatId);
        return;
      }

      const commentData = await getComment(confessionId);
      let commentText = `💬 *Comments for Confession #${confession.confessionNumber}*\n\n`;
      commentText += `*Confession:*\n${confession.text.substring(0, 200)}${confession.text.length > 200 ? '...' : ''}\n\n`;

      const commentList = commentData.comments || [];
      if (commentList.length === 0) {
        commentText += 'No comments yet. Be the first to comment!\n\n';
      } else {
        commentText += `*Recent Comments (${commentList.length} total):*\n\n`;
        for (let i = 0; i < Math.min(commentList.length, 3); i++) {
          const comment = commentList[i];
          const user = await getUser(comment.userId);
          commentText += `${i + 1}. ${comment.text}\n`;
          commentText += `   - ${user?.username || 'Anonymous'}\n\n`;
        }
      }

      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '📝 Add Comment', callback_data: `add_comment_${confessionId}` },
              { text: '👁️ View All Comments', callback_data: `comments_page_${confessionId}_1` }
            ],
            [
              { text: '📝 Send Your Confession', callback_data: 'send_confession' },
              { text: '🔙 Main Menu', callback_data: 'back_to_menu' }
            ]
          ]
        }
      };

      await bot.sendMessage(chatId, commentText, { 
        parse_mode: 'Markdown',
        ...keyboard
      });
      return;
    }

    // Get or create user
    const user = await getUser(userId, msg);
    
    if (user.isActive === false) {
      await bot.sendMessage(chatId, '❌ Your account has been blocked by admin.');
      return;
    }

    // If user doesn't have a username, prompt them to set one
    if (!user.username || user.username === 'Anonymous') {
      await bot.sendMessage(chatId,
        `🤫 *Welcome to JU Confession Bot!*\n\n` +
        `First, please set your display name:\n\n` +
        `Enter your desired name (3-20 characters, letters/numbers/underscores only):`
      );
      
      await setUserState(userId, {
        state: 'awaiting_username',
        originalChatId: chatId
      });
      return;
    }

    // Check if user has state to recover
    const userState = await getUserState(userId);
    if (userState) {
      if (userState.state === 'awaiting_confession') {
        await bot.sendMessage(chatId,
          `✍️ *Send Your Confession*\n\nType your confession below (max 1000 characters):\n\nYou can add hashtags like #love #study #funny`,
          { parse_mode: 'Markdown' }
        );
        return;
      }
    }

    await bot.sendMessage(chatId,
      `🤫 *Welcome back, ${user.username}!*\n\n` +
      `Send me your confession and it will be submitted anonymously for admin approval.\n\n` +
      `Your identity will never be revealed!`,
      { parse_mode: 'Markdown' }
    );

    await showMainMenu(chatId);
  };

  // ========== SEND CONFESSION ========== //
  const handleSendConfession = async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const user = await getUser(userId);

    if (!user.isActive) {
      await bot.sendMessage(chatId, '❌ Your account has been blocked by admin.');
      return;
    }

    // Check cooldown
    const canSubmit = await checkCooldown(userId, 'confession', 60000);
    if (!canSubmit) {
      await bot.sendMessage(chatId, 'Please wait 60 seconds before submitting another confession.');
      return;
    }

    await setUserState(userId, {
      state: 'awaiting_confession'
    });

    await bot.sendMessage(chatId,
      `✍️ *Send Your Confession*\n\nType your confession below (max 1000 characters):\n\nYou can add hashtags like #love #study #funny`,
      { parse_mode: 'Markdown' }
    );
  };

  // ========== CONFESSION SUBMISSION ========== //
  const handleConfessionSubmission = async (msg, text) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!text || text.trim().length < 5) {
      await bot.sendMessage(chatId, '❌ Confession too short. Minimum 5 characters.');
      return;
    }

    if (text.length > 1000) {
      await bot.sendMessage(chatId, '❌ Confession too long. Maximum 1000 characters.');
      return;
    }

    try {
      const sanitizedText = sanitizeInput(text);
      const confessionId = `confess_${userId}_${Date.now()}`;
      const hashtags = extractHashtags(sanitizedText);

      const confessionNumber = await incrementCounter('confessionNumber');
      const confessionData = {
        id: confessionId,
        confessionId: confessionId,
        userId: userId,
        text: sanitizedText.trim(),
        status: 'pending',
        createdAt: new Date().toISOString(),
        hashtags: hashtags,
        totalComments: 0,
        confessionNumber: confessionNumber,
        likes: 0
      };

      await createConfession(confessionData);

      // Update user stats
      await updateUser(userId, {
        totalConfessions: admin.firestore.FieldValue.increment(1)
      });

      // Set cooldown
      await setCooldown(userId, 'confession');

      // Notify admins
      await notifyAdmins(confessionId, sanitizedText, confessionNumber);

      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '📝 Send Another', callback_data: 'send_confession' },
              { text: '📢 Promote Bot', callback_data: 'promote_bot' }
            ],
            [
              { text: '🔙 Back to Menu', callback_data: 'back_to_menu' }
            ]
          ]
        }
      };

      await bot.sendMessage(chatId,
        `✅ *Confession Submitted!*\n\nYour confession is under review. You'll be notified when approved.`,
        { parse_mode: 'Markdown', ...keyboard }
      );

    } catch (error) {
      console.error('Submission error:', error);
      await bot.sendMessage(chatId, '❌ Error submitting confession. Please try again.');
    }
  };

  // ========== NOTIFY ADMINS ========== //
  const notifyAdmins = async (confessionId, text, confessionNumber) => {
    const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(Number) : [];
    
    if (ADMIN_IDS.length === 0) {
      console.log('❌ No admin IDs configured in environment variables');
      return;
    }

    const previewText = text.length > 200 ? text.substring(0, 200) + '...' : text;
    const message = `🤫 *New Confession #${confessionNumber}*\n\n${previewText}\n\n*Actions:*`;

    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Approve', callback_data: `approve_${confessionId}` },
            { text: '❌ Reject', callback_data: `reject_${confessionId}` }
          ]
        ]
      }
    };

    console.log(`📤 Notifying ${ADMIN_IDS.length} admins about confession ${confessionId}`);

    for (const adminId of ADMIN_IDS) {
      try {
        await bot.sendMessage(adminId, message, { 
          parse_mode: 'Markdown', 
          ...keyboard 
        });
      } catch (error) {
        console.error(`Admin notify error ${adminId}:`, error.message);
      }
    }
  };

  // ========== POST TO CHANNEL ========== //
  const postToChannel = async (text, number, confessionId) => {
    const CHANNEL_ID = process.env.CHANNEL_ID;
    const BOT_USERNAME = process.env.BOT_USERNAME;
    
    if (!CHANNEL_ID) {
      console.error('❌ CHANNEL_ID not configured');
      return;
    }

    try {
      // Create the message with confession number and text only once
      const message = `#${number}\n\n${text}\n\n💬 Comment on this confession:`;
      
      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            [
              { 
                text: '👁️‍🗨️ View/Add Comments', 
                url: `https://t.me/${BOT_USERNAME}?start=comment_${confessionId}`
              }
            ]
          ]
        }
      };

      // Send the message ONLY ONCE with the keyboard
      const sentMessage = await bot.sendMessage(CHANNEL_ID, message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard.reply_markup
      });

      // Initialize comments collection
      await updateComment(confessionId, {
        confessionId: confessionId,
        confessionNumber: number,
        confessionText: text,
        comments: [],
        totalComments: 0,
        channelMessageId: sentMessage.message_id
      });
      
      console.log(`✅ Confession #${number} posted to channel`);
      return sentMessage;
    } catch (error) {
      console.error('Channel post error:', error);
      throw error;
    }
  };

  // ========== ADMIN COMMANDS ========== //
  const handleApproveConfession = async (chatId, userId, confessionId, callbackQueryId) => {
    if (!isAdmin(userId)) {
      await bot.answerCallbackQuery(callbackQueryId, { text: '❌ Access denied' });
      return;
    }

    const confession = await getConfession(confessionId);
    if (!confession) {
      await bot.answerCallbackQuery(callbackQueryId, { text: '❌ Confession not found' });
      return;
    }

    try {
      await updateConfession(confessionId, {
        status: 'approved',
        approvedAt: new Date().toISOString()
      });

      // Update user reputation
      await updateUser(confession.userId, {
        reputation: admin.firestore.FieldValue.increment(10)
      });

      // Post to channel
      await postToChannel(confession.text, confession.confessionNumber, confessionId);
      
      // Notify user
      await notifyUser(confession.userId, confession.confessionNumber, 'approved');

      await bot.answerCallbackQuery(callbackQueryId, { text: '✅ Confession approved!' });
      
      // Edit the original message to remove buttons
      try {
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          {
            chat_id: chatId,
            message_id: callbackQueryId.message.message_id
          }
        );
      } catch (editError) {
        // Ignore edit errors
      }

    } catch (error) {
      console.error('Approve confession error:', error);
      await bot.answerCallbackQuery(callbackQueryId, { text: '❌ Error approving confession' });
    }
  };

  const handleRejectConfession = async (chatId, userId, confessionId, callbackQueryId) => {
    if (!isAdmin(userId)) {
      await bot.answerCallbackQuery(callbackQueryId, { text: '❌ Access denied' });
      return;
    }

    await setUserState(userId, {
      state: 'awaiting_rejection_reason',
      confessionId: confessionId
    });

    await bot.sendMessage(chatId, 
      `❌ *Rejecting Confession*\n\nPlease provide rejection reason:`
    );
    
    await bot.answerCallbackQuery(callbackQueryId, { text: 'Please provide rejection reason' });
  };

  // ========== VIEW COMMENTS ========== //
  const handleViewComments = async (chatId, confessionId, page = 1) => {
    const commentData = await getComment(confessionId);
    const confession = await getConfession(confessionId);
    
    if (!commentData || !confession) {
      await bot.sendMessage(chatId, '❌ Confession not found or may have been deleted.');
      await showMainMenu(chatId);
      return;
    }

    const commentList = commentData.comments || [];
    const commentsPerPage = 5;
    const totalPages = Math.ceil(commentList.length / commentsPerPage);
    const startIndex = (page - 1) * commentsPerPage;
    const endIndex = startIndex + commentsPerPage;
    const pageComments = commentList.slice(startIndex, endIndex);

    let commentText = `💬 *Comments for Confession #${confession.confessionNumber}*\n\n`;
    commentText += `*Confession Preview:*\n${confession.text.substring(0, 150)}${confession.text.length > 150 ? '...' : ''}\n\n`;

    if (pageComments.length === 0) {
      commentText += 'No comments yet. Be the first to comment!\n\n';
    } else {
      commentText += `*Comments (${startIndex + 1}-${Math.min(endIndex, commentList.length)} of ${commentList.length}):*\n\n`;
      for (let i = 0; i < pageComments.length; i++) {
        const comment = pageComments[i];
        const user = await getUser(comment.userId);
        const userLevel = getUserLevel(await getCommentCount(comment.userId));
        
        commentText += `${startIndex + i + 1}. ${comment.text}\n`;
        commentText += `   - ${userLevel.symbol} ${user?.username || 'Anonymous'}\n`;
        commentText += `   📅 ${comment.timestamp || new Date(comment.createdAt).toLocaleDateString()}\n\n`;
      }
    }

    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📝 Add Comment', callback_data: `add_comment_${confessionId}` }
          ]
        ]
      }
    };

    // Add pagination buttons if needed
    if (totalPages > 1) {
      const paginationRow = [];
      
      if (page > 1) {
        paginationRow.push({ text: '⬅️ Previous', callback_data: `comments_page_${confessionId}_${page - 1}` });
      }
      
      paginationRow.push({ text: `${page}/${totalPages}`, callback_data: `current_page` });
      
      if (page < totalPages) {
        paginationRow.push({ text: 'Next ➡️', callback_data: `comments_page_${confessionId}_${page + 1}` });
      }
      
      keyboard.reply_markup.inline_keyboard.push(paginationRow);
    }

    // Add navigation buttons
    keyboard.reply_markup.inline_keyboard.push([
      { text: '📝 Send Confession', callback_data: 'send_confession' },
      { text: '🔙 Main Menu', callback_data: 'back_to_menu' }
    ]);

    await bot.sendMessage(chatId, commentText, { 
      parse_mode: 'Markdown',
      ...keyboard
    });
  };

  // ========== ADD COMMENT ========== //
  const handleAddComment = async (chatId, confessionId, commentText) => {
    const userId = chatId;
    
    if (!commentText || commentText.trim().length < 3) {
      await bot.sendMessage(chatId, '❌ Comment too short. Minimum 3 characters.');
      return;
    }

    const commentData = await getComment(confessionId);
    if (!commentData) {
      await bot.sendMessage(chatId, '❌ Confession not found.');
      return;
    }

    const sanitizedComment = sanitizeInput(commentText);

    const newComment = {
      id: `comment_${Date.now()}_${userId}`,
      text: sanitizedComment.trim(),
      userId: userId,
      userName: (await getUser(userId)).username || 'Anonymous',
      timestamp: new Date().toLocaleString(),
      createdAt: new Date().toISOString()
    };

    const updatedComments = [...(commentData.comments || []), newComment];
    await updateComment(confessionId, {
      ...commentData,
      comments: updatedComments,
      totalComments: (commentData.totalComments || 0) + 1
    });

    // Update confession total comments
    await updateConfession(confessionId, {
      totalComments: admin.firestore.FieldValue.increment(1)
    });

    const user = await getUser(userId);
    await updateUser(userId, {
      reputation: admin.firestore.FieldValue.increment(5)
    });

    await bot.sendMessage(chatId, '✅ Comment added successfully!');
    
    // Get confession author and send notification if enabled
    const confession = await getConfession(confessionId);
    if (confession && confession.userId !== userId) {
      await sendNotification(confession.userId,
        `💬 *New Comment on Your Confession*\n\nConfession #${confession.confessionNumber} has a new comment!\n\n"${sanitizedComment.substring(0, 50)}${sanitizedComment.length > 50 ? '...' : ''}"`,
        'newComment'
      );
    }
    
    await handleViewComments(chatId, confessionId);
  };

  // ========== CALLBACK QUERY HANDLER ========== //
  const handleCallbackQuery = async (callbackQuery) => {
    const message = callbackQuery.message;
    const userId = callbackQuery.from.id;
    const data = callbackQuery.data;
    const chatId = message.chat.id;

    try {
      console.log(`📨 Callback received: ${data} from user ${userId}`);

      // Admin actions
      if (data.startsWith('approve_')) {
        const confessionId = data.replace('approve_', '');
        await handleApproveConfession(chatId, userId, confessionId, callbackQuery.id);
      } else if (data.startsWith('reject_')) {
        const confessionId = data.replace('reject_', '');
        await handleRejectConfession(chatId, userId, confessionId, callbackQuery.id);
      
      // Comment actions
      } else if (data.startsWith('add_comment_')) {
        const confessionId = data.replace('add_comment_', '');
        await setUserState(userId, {
          state: 'awaiting_comment',
          confessionId: confessionId
        });
        await bot.sendMessage(chatId, `📝 *Add Comment*\n\nType your comment for this confession:`);
        await bot.answerCallbackQuery(callbackQuery.id);
      } else if (data.startsWith('comments_page_')) {
        const parts = data.split('_');
        const confessionId = parts[2];
        const page = parseInt(parts[3]);
        await handleViewComments(chatId, confessionId, page);
        await bot.answerCallbackQuery(callbackQuery.id);
      
      } else if (data === 'current_page') {
        await bot.answerCallbackQuery(callbackQuery.id);
      
      // Main menu actions
      } else if (data === 'send_confession') {
        await handleSendConfession({ chat: { id: chatId }, from: { id: userId } });
        await bot.answerCallbackQuery(callbackQuery.id);
      } else if (data === 'back_to_menu') {
        await showMainMenu(chatId);
        await bot.answerCallbackQuery(callbackQuery.id);
      } else if (data === 'promote_bot') {
        const BOT_USERNAME = process.env.BOT_USERNAME;
        const CHANNEL_ID = process.env.CHANNEL_ID;
        await bot.sendMessage(chatId,
          `📢 *Help Us Grow!*\n\nShare our bot with friends:\nhttps://t.me/${BOT_USERNAME}\n\nJoin our channel for confessions:`,
          { 
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [
                  { 
                    text: '📤 Share Bot', 
                    url: `https://t.me/share/url?url=https://t.me/${BOT_USERNAME}&text=Check%20out%20this%20anonymous%20confession%20bot!`
                  }
                ],
                [
                  { 
                    text: '📢 Join Channel', 
                    url: CHANNEL_ID.startsWith('@') ? `https://t.me/${CHANNEL_ID.slice(1)}` : `https://t.me/juconfessions`
                  }
                ]
              ]
            }
          }
        );
        await bot.answerCallbackQuery(callbackQuery.id);
      
      // Default case
      } else {
        await bot.answerCallbackQuery(callbackQuery.id);
      }

    } catch (error) {
      console.error('Callback error:', error);
      await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Error processing request' });
    }
  };

  // ========== MESSAGE HANDLER ========== //
  const handleMessage = async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;

    if (!text || text.trim().length === 0) return;

    const userState = await getUserState(userId);
    
    // Handle user states
    if (userState) {
      if (userState.state === 'awaiting_username') {
        if (text.length < 3 || text.length > 20 || !/^[a-zA-Z0-9_]+$/.test(text)) {
          await bot.sendMessage(chatId, '❌ Invalid username. Use 3-20 characters (letters, numbers, underscores only).');
          return;
        }

        // Check if username already exists (excluding 'Anonymous')
        if (text.toLowerCase() !== 'anonymous') {
          const usersSnapshot = await db.collection('users').where('username', '==', text).limit(1).get();
          if (!usersSnapshot.empty && usersSnapshot.docs[0].data().telegramId !== userId) {
            await bot.sendMessage(chatId, '❌ Username already taken. Choose another one.');
            return;
          }
        }

        await updateUser(userId, { username: text });
        await clearUserState(userId);
        
        await bot.sendMessage(chatId, `✅ Display name updated to ${text}!`);
        await showMainMenu(chatId);
        return;
      }

      if (userState.state === 'awaiting_confession') {
        await handleConfessionSubmission(msg, text);
        await clearUserState(userId);
        return;
      }

      if (userState.state === 'awaiting_comment') {
        await handleAddComment(chatId, userState.confessionId, text);
        await clearUserState(userId);
        return;
      }

      if (userState.state === 'awaiting_rejection_reason' && isAdmin(userId)) {
        const confessionId = userState.confessionId;
        const confession = await getConfession(confessionId);
        
        if (confession) {
          await updateConfession(confessionId, {
            status: 'rejected',
            rejectionReason: text
          });

          await notifyUser(confession.userId, confession.confessionNumber, 'rejected', text);
          
          await bot.sendMessage(chatId, `✅ Confession rejected.`);
        }
        await clearUserState(userId);
        return;
      }
    }

    // Handle commands
    if (text.startsWith('/')) {
      switch (text) {
        case '/start':
          await handleStart(msg);
          break;
        case '/admin':
          if (isAdmin(userId)) {
            await bot.sendMessage(chatId, '🔐 *Admin Panel*\n\nUse the buttons below to manage the bot:', {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: '👥 Manage Users', callback_data: 'manage_users' },
                    { text: '📝 Review Confessions', callback_data: 'review_confessions' }
                  ],
                  [
                    { text: '📊 Statistics', callback_data: 'bot_stats' }
                  ]
                ]
              }
            });
          } else {
            await bot.sendMessage(chatId, '❌ Access denied. Admin only command.');
          }
          break;
        default:
          await showMainMenu(chatId);
      }
    } else {
      // Handle menu buttons
      switch (text) {
        case '📝 Send Confession':
          await handleSendConfession(msg);
          break;
        case '👤 My Profile':
          const user = await getUser(userId);
          const commentCount = await getCommentCount(userId);
          const levelInfo = getUserLevel(commentCount);

          const profileText = `👤 *My Profile*\n\n` +
            `**Display Name:** ${user.username}\n` +
            `**Level:** ${levelInfo.symbol} ${levelInfo.name} (${commentCount} comments)\n` +
            `**Reputation:** ${user.reputation || 0}⭐\n` +
            `**Followers:** ${user.followers?.length || 0}\n` +
            `**Following:** ${user.following?.length || 0}\n` +
            `**Confessions:** ${user.totalConfessions || 0}\n` +
            `**Member Since:** ${new Date(user.joinedAt).toLocaleDateString()}`;

          await bot.sendMessage(chatId, profileText, { parse_mode: 'Markdown' });
          break;
        case '📢 Promote Bot':
          const BOT_USERNAME = process.env.BOT_USERNAME;
          await bot.sendMessage(chatId,
            `📢 *Help Us Grow!*\n\nShare our bot with friends:\nhttps://t.me/${BOT_USERNAME}`,
            { parse_mode: 'Markdown' }
          );
          break;
        default:
          await showMainMenu(chatId);
      }
    }
  };

  // ========== VERCEL HANDLER ========== //
  module.exports = async (req, res) => {
    console.log('📨 Received request:', req.method);

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      return res.status(200).end();
    }

    if (req.method === 'GET') {
      return res.status(200).json({
        status: 'online',
        message: 'JU Confession Bot is running!',
        timestamp: new Date().toISOString()
      });
    }

    if (req.method === 'POST') {
      try {
        const update = req.body;
        console.log('📥 Update received:', update.update_id);

        if (update.message) {
          await handleMessage(update.message);
        } else if (update.callback_query) {
          await handleCallbackQuery(update.callback_query);
        }

        return res.status(200).json({ ok: true });
      } catch (error) {
        console.error('❌ Error processing update:', error);
        return res.status(200).json({ error: 'Internal server error', acknowledged: true });
      }
    }

    return res.status(405).json({ error: 'Method not allowed' });
  };

  console.log('✅ JU Confession Bot configured for Vercel!');
  console.log('🚀 Bot is ready to use!');

} catch (error) {
  console.error('❌ Bot initialization error:', error);
  }
