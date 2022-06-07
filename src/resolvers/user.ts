import { Arg, createUnionType, Ctx, Field, FieldResolver, Int, Mutation, ObjectType, Query, Resolver, Root } from "type-graphql";
import User from "../entities/User";
import RegisterInput from "../inputs/RegisterInput";
import { MyContext } from "../types";
import argon2 from "argon2";
import { SESSION_COOKIE } from "../constants";
import Subscription from "../entities/Subscription";
import getSubscriptionSize from "../utils/getSubscriptionSize";
import { getManager } from "typeorm";
import mkDefaultDir from "../utils/mkDefaultDir";
import rmClientDir from "../utils/rmDefaultDir";
import getFirstValidationError from "../utils/getFirstValidationError";
import validators from "../utils/validators";
import getGenericServerError from "../utils/getGenericServerError";
import { sendRegisterConfirmationEmail } from "../utils/sendEmail";
import { v4 as uuid } from "uuid";
import { getRegisterConfirmationKey } from "../redis/keys";

function deleteUserInDb(id: number) {
    return getManager().transaction(async transaction => {
        await transaction.delete(Subscription, { userId: id });
        return await transaction.delete(User, id);
    });
}

function pushFieldError(errors: FormError[], name: string, value: string) {
    const error = getFirstValidationError((validators as any)[name], value);
    if (!error) return;

    errors.push({
        field: name,
        message: error
    });
}

@ObjectType()
class FormError {
    @Field({ nullable: true })
    field?: string;

    @Field()
    message: string;
}

@ObjectType()
class FormErrors {
    @Field(() => [FormError])
    errors: FormError[];

    constructor(errors: FormError[]) {
        this.errors = errors;
    }
}

@ObjectType()
class BooleanResponse {
    @Field()
    response: boolean;

    constructor(response: boolean) {
        this.response = response;
    }
}

const UserFormResponse = createUnionType({
    name: "UserFormResponse",
    types: () => [User, FormErrors] as const
});

const BooleanFormResponse = createUnionType({
    name: "BooleanFormResponse",
    types: () => [BooleanResponse, FormErrors] as const
});

@Resolver(User)
export default class UserResolver {
    @FieldResolver()
    async currentSubscription(
        @Root() user: User,
        @Ctx() { orm }: MyContext
    ) {
        const now = new Date();
        const userWithSubscription = await orm
            .getRepository("user")
            .createQueryBuilder("user")
            .leftJoinAndSelect("user.subscriptions", "subscription")
            .where("user.id = :id", { id: user.id })
            .andWhere("subscription.from <= :date", { date: now })
            .andWhere("subscription.to >= :date", { date: now })
            .getOne() as User || undefined; // Only one subscription tier so we don't care getting the best one

        if (!userWithSubscription) {
            user.currentSubscription = "free";
        } else {
            const subscription = userWithSubscription.subscriptions[0];
            user.currentSubscription = subscription.type;
        }

        user.save();

        return user.currentSubscription;
    }

    @FieldResolver(() => Int)
    subscriptionSize(@Root() user: User) {
        return getSubscriptionSize(user.currentSubscription);
    }

    @Query(() => User, { nullable: true })
    async user(
        @Ctx() { req }: MyContext
    ): Promise<User | null> {
        if (!req.session.userId) return null;

        const user = await User.findOneOrFail(req.session.userId);

        //const subscriptions = await Subscription.findOne(user.id);

        return user;
    }

    @Mutation(() => BooleanFormResponse)
    async register(
        @Arg("inputs") { username, email, password }: RegisterInput,
        @Ctx() { redis }: MyContext
    ): Promise<typeof BooleanFormResponse> {
        const errors: FormError[] = [];
        pushFieldError(errors, "username", username);
        pushFieldError(errors, "email", email);
        pushFieldError(errors, "password", password);
        if (errors.length) return new FormErrors(errors);

        const hash = await argon2.hash(password);

        let user;
        try {
            user = await User.create({ username, email, password: hash }).save();
        } catch(e) {
            if (e.code !== '35505' && !e.detail.includes("already exists")) {
                console.error(e);
                return new FormErrors([ getGenericServerError(e) ]);
            }

            user = await User.findOne({ email });
            // User does not exists or exists but is confirmed already
            if (!user || user.confirmed)
                return new FormErrors([{ message: "Email already taken." }]);
        }

        const token = uuid();
        const oneDayInMs = 1000 * 3600 * 24;
        await redis.set(getRegisterConfirmationKey(token), user.id, "ex", oneDayInMs);
        await sendRegisterConfirmationEmail(user.username, user.email, token);

        return new BooleanResponse(true);
    }

    @Mutation(() => UserFormResponse)
    async confirmRegister(
        @Arg("token") token: string,
        @Ctx() { req, redis }: MyContext
    ): Promise<typeof UserFormResponse> {
        const key = getRegisterConfirmationKey(token);
        const userId = await redis.get(key);
        if (!userId) return new FormErrors([{ field: "token", message: "Token expired" }]);

        const user = await User.findOne(parseInt(userId));
        if (!user) return new FormErrors([{ field: "token", message: "User no longer exists." }]);

        const clientId = user.id.toString();

        try {
            await mkDefaultDir(clientId);
        } catch(e) {
            try {
                await rmClientDir(clientId);
            } catch(e) { console.error(e) }

            return new FormErrors([ getGenericServerError(e) ]);
        }

        user.confirmed = true;
        await user.save();
        await redis.del(key);

        req.session.userId = user.id;
        req.session.clientId = clientId;

        return user;
    }

    @Mutation(() => UserFormResponse)
    async login(
        @Arg("email") email: string,
        @Arg("password") password: string,
        @Ctx() { req }: MyContext
    ): Promise<typeof UserFormResponse> {
        const errors: FormError[] = [];
        pushFieldError(errors, "email", email);
        pushFieldError(errors, "password", password);
        if (errors.length) return new FormErrors(errors);

        // Wait >= 0.5s and < 0.75s
        // Makes it harder to know if a user has been found
        // Prevents bruteforce attack
        const waitTime = (Math.random() / 4 + 0.5) * 1000;
        await new Promise(resolve => setTimeout(resolve, waitTime));

        let user;
        try {
            user = await User.findOne({ email });
        } catch(e) {
            return new FormErrors([ getGenericServerError(e) ]);
        }

        if (!user) return new FormErrors([{ message: "Wrong email or password." }]);
        //TODO resend code button
        if (!user.confirmed) return new FormErrors([{ message: "Registration not finished, validate your email first." }]);

        const valid = await argon2.verify(user.password, password);
        //TODO If the user exist ask if he need help
        if (!valid) return new FormErrors([{ message: "Wrong email or password." }]);

        req.session.userId = user.id;
        req.session.clientId = user.id.toString();

        return user;
    }

    @Mutation(() => Boolean)
    logout(
        @Ctx() { req, res }: MyContext
    ): Promise<boolean> {
        return new Promise(resolve => req.session.destroy(err => {
            res.clearCookie(SESSION_COOKIE);
            resolve(!err);
        }));
    }

    @Mutation(() => Boolean)
    async deleteUser(
        @Arg("email") email: string,
        @Arg("password") password: string
    ): Promise<boolean> {
        //TODO send an email with confirmation link
        const user = await User.findOne({ email });
        if (!user) return false;

        const valid = await argon2.verify(user.password, password);
        if (!valid) return false;

        const { id } = user;
        const clientId = id.toString();

        const result = await deleteUserInDb(id);
        await rmClientDir(clientId);

        return !!result.affected;
    }
}
