import mongoose from 'mongoose';

// Connect once at startup. Mongoose maintains a single shared connection pool,
// so models defined anywhere in the app reuse this connection. The URI is read
// at call time (not import time) so scripts/tests can point at a different
// database before connecting.
export const connectMongo = async () => {
  const mongoUri = process.env.MONGODB_URI;

  if (!mongoUri) {
    throw new Error('Missing MONGODB_URI.');
  }

  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB');
};
