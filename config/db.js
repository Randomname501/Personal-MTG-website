import mongoose from 'mongoose';

const mongoUri = process.env.MONGODB_URI;

if (!mongoUri) {
  throw new Error(
    'Missing MONGODB_URI. Did you create a .env file? See .env.example.'
  );
}

// Connect once at startup. Mongoose maintains a single shared connection pool,
// so models defined anywhere in the app reuse this connection.
export const connectMongo = async () => {
  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB');
};
