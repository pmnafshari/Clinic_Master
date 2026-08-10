import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import * as bcrypt from 'bcryptjs';
import { handlePrismaError } from '../../common/utils/prisma-error.util';
import { USER_PUBLIC_SELECT as SAFE_USER_SELECT } from '../../common/constants/prisma-selects';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    try {
      return await this.prisma.user.findMany({
        select: SAFE_USER_SELECT,
        orderBy: { createdAt: 'desc' },
      });
    } catch (error) {
      handlePrismaError(error);
    }
  }

  async findProviders() {
    try {
      return await this.prisma.user.findMany({
        where: { role: { name: 'dentist' }, isActive: true },
        select: SAFE_USER_SELECT,
        orderBy: { firstName: 'asc' },
      });
    } catch (error) {
      handlePrismaError(error);
    }
  }

  async findById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: SAFE_USER_SELECT,
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  async findByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: { email },
      include: { role: true },
    });
  }

  async create(createUserDto: CreateUserDto) {
    const existingUser = await this.findByEmail(createUserDto.email);
    if (existingUser) {
      throw new ConflictException('Email already exists');
    }

    const { password, ...rest } = createUserDto;
    const passwordHash = await bcrypt.hash(password, 10);

    try {
      return await this.prisma.user.create({
        data: { ...rest, passwordHash },
        select: SAFE_USER_SELECT,
      });
    } catch (error) {
      handlePrismaError(error);
    }
  }

  async update(id: string, updateUserDto: UpdateUserDto) {
    await this.findById(id);

    const { password, ...rest } = updateUserDto;
    const data: any = { ...rest };
    if (password) {
      data.passwordHash = await bcrypt.hash(password, 10);
    }

    try {
      return await this.prisma.user.update({
        where: { id },
        data,
        select: SAFE_USER_SELECT,
      });
    } catch (error) {
      handlePrismaError(error);
    }
  }

  async deactivate(id: string) {
    await this.findById(id);

    try {
      return await this.prisma.user.update({
        where: { id },
        data: { isActive: false },
        select: SAFE_USER_SELECT,
      });
    } catch (error) {
      handlePrismaError(error);
    }
  }
}
